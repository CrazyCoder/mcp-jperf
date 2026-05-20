/**
 * CLI-only (no IDE) JFR aggregator. Reads jfr's text-mode dump of profiler.*
 * and jdk.ExecutionSample events and exposes the building blocks every tier-2
 * profile_* tool needs:
 *
 *   - `runJfrTextSamples()` — stream events with leaf-first frame arrays
 *   - `subsystemKey()`      — package-prefix subsystem derivation
 *   - `classifyThreadGroup()`
 *   - `aggregatePerThread()` — per-thread + per-subsystem aggregator
 *   - `buildCallTree()`     — synthesized tree from frame stacks (each frame
 *     contributes its event weight to itself and all callers)
 *
 * Output is sample-count fidelity only — no IDE-side wall-clock scaling.
 * Tools that use this set `metric: "samples"` and `source: "jfr-cli"`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_WALL_CLOCK_EVENTS = [
  "profiler.WallClockSleeping",
  "profiler.WallClockSample",
  "jdk.ExecutionSample",
] as const;

export interface RawSampleEvent {
  thread: string;
  samples: number;
  frames: string[]; // leaf-first
}

export type ThreadGroup =
  | "edt"
  | "idePool"
  | "dispatcher"
  | "fjPool"
  | "indexing"
  | "telemetry"
  | "gc"
  | "other";

/** Classifier matching extract-list-threads.kts / extract-per-thread.kts. */
export function classifyThreadGroup(name: string): ThreadGroup {
  if (name.startsWith("AWT-EventQueue")) return "edt";
  if (name.startsWith("ApplicationImpl pooled thread")) return "idePool";
  if (name.startsWith("DefaultDispatcher-worker")) return "dispatcher";
  if (name.startsWith("JobScheduler FJ pool")) return "fjPool";
  if (name.startsWith("Indexing-") || name.includes("FileBasedIndex")) return "indexing";
  if (name.startsWith("BatchSpan") || name.includes("Telemetry")) return "telemetry";
  if (name.includes("GC") || name.startsWith("G1 ")) return "gc";
  return "other";
}

// Native frames: jvm.dll / libjvm.so / libjvm.dylib, plus async-profiler sentinels.
const NATIVE_FILE_RE = /[\\/]([^\\/]+\.(?:dll|so|dylib))\b/i;
const JAVA_HEAD_RE = /^([\p{L}\p{N}_$.]+)/u;
const STARTS_UPPER_RE = /^\p{Lu}/u;
const STDLIB_PREFIX_RE = /^(java|javax|jdk|sun|com\.sun|kotlin|kotlinx|jakarta|scala)\./;

export function isNativeFrame(frame: string): boolean {
  return (
    NATIVE_FILE_RE.test(frame) ||
    frame.startsWith("CantBeParsedCall") ||
    frame === "no_Java_frame()"
  );
}

/**
 * Subsystem key for one frame. Native frames bucket by dll/so basename; stdlib
 * frames return null (caller decides what to do with them — for subsystem-scan
 * they are ignored; for full call-tree they keep their natural frame).
 */
export function subsystemKey(frame: string, depth: number): string | null {
  if (!frame) return null;
  if (frame.startsWith("CantBeParsedCall")) return "<native:unknown>";
  const nm = NATIVE_FILE_RE.exec(frame);
  if (nm) return `<native:${nm[1].toLowerCase()}>`;
  const jm = JAVA_HEAD_RE.exec(frame);
  if (!jm) return null;
  const head = jm[1];
  if (STDLIB_PREFIX_RE.test(head)) return null;
  const segs = head.split(".");
  let classIdx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (STARTS_UPPER_RE.test(segs[i])) {
      classIdx = i;
      break;
    }
  }
  if (classIdx <= 0) return null;
  const pkg = segs.slice(0, classIdx);
  const trimmed = pkg.slice(0, depth);
  return trimmed.length === 0 ? null : trimmed.join(".");
}

/** Per-event distinct subsystem set (dedup-per-event). Excludes native/stdlib/sentinel keys. */
export function subsystemsForStack(frames: string[], depth: number): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  for (const frame of frames) {
    if (isNativeFrame(frame)) continue;
    const m = JAVA_HEAD_RE.exec(frame);
    if (!m || STDLIB_PREFIX_RE.test(m[1])) continue;
    const key = subsystemKey(frame, depth);
    if (!key || key.startsWith("<")) continue;
    let bucket = seen.get(key);
    if (!bucket) {
      bucket = new Set();
      seen.set(key, bucket);
    }
    bucket.add(frame);
  }
  return seen;
}

function normalizeFrame(rawLine: string): string {
  let s = rawLine.trim();
  if (s.startsWith(".")) s = s.slice(1);
  s = s.replace(/\(\)\s+line:\s+\d+$/, "()");
  s = s.replace(/\)\s+line:\s+\d+$/, ")");
  return s;
}

/**
 * Stream `jfr print --events <csv> --stack-depth N <file>` and invoke
 * `onEvent` per parsed event. Resolves on process close.
 */
export function runJfrTextSamples(
  filepath: string,
  events: readonly string[],
  stackDepth: number,
  onEvent: (ev: RawSampleEvent) => void,
): Promise<{ eventCount: number }> {
  return new Promise((resolve, reject) => {
    const jfrPath = resolveJfrCli();
    const args = [
      "print",
      "--events",
      events.join(","),
      "--stack-depth",
      String(stackDepth),
      filepath,
    ];
    const child = spawn(jfrPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let buf = "";
    let mode: "idle" | "in_event" | "in_stack" | "after_stack" = "idle";
    let cur: { thread: string | null; samples: number; frames: string[] } | null = null;
    let eventCount = 0;

    function processLine(line: string): void {
      if (mode === "idle") {
        if (line.endsWith(" {") && /^\S+\s*\{$/.test(line)) {
          mode = "in_event";
          cur = { thread: null, samples: 1, frames: [] };
        }
        return;
      }
      if (mode === "in_event") {
        if (line.startsWith("  samplesCount =")) {
          const m = line.match(/samplesCount\s*=\s*(\d+)/);
          if (m && cur) cur.samples = parseInt(m[1], 10);
          return;
        }
        const tm = line.match(/^\s+(eventThread|sampledThread)\s*=\s*"([^"]*)"/);
        if (tm && cur) {
          cur.thread = tm[2];
          return;
        }
        if (line.endsWith("stackTrace = [")) {
          mode = "in_stack";
          return;
        }
        if (line === "}") {
          if (cur && cur.thread) {
            onEvent({ thread: cur.thread, samples: cur.samples, frames: cur.frames });
            eventCount++;
          }
          cur = null;
          mode = "idle";
        }
        return;
      }
      if (mode === "in_stack") {
        const t = line.trim();
        if (t === "]" || t === "..." || t === ", ...]") {
          mode = "after_stack";
          return;
        }
        if (line.startsWith("    ") && cur) {
          cur.frames.push(normalizeFrame(line));
        }
        return;
      }
      if (mode === "after_stack") {
        if (line === "}" || line === "  }") {
          if (cur && cur.thread) {
            onEvent({ thread: cur.thread, samples: cur.samples, frames: cur.frames });
            eventCount++;
          }
          cur = null;
          mode = "idle";
        }
      }
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        processLine(line);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => {
      const hint = process.env.JAVA_HOME
        ? "Check that JAVA_HOME points to JDK (jfr is in JDK 9+)."
        : "Set JAVA_HOME or add JDK bin to PATH.";
      reject(new Error(`jfr not found: ${err.message}. ${hint}`));
    });
    child.on("close", (code) => {
      if (buf.length) processLine(buf);
      if (code !== 0) {
        reject(new Error(`jfr exited ${code}: ${stderr.slice(0, 1000)}`));
        return;
      }
      resolve({ eventCount });
    });
  });
}

function resolveJfrCli(): string {
  const home = process.env.JAVA_HOME;
  if (home) {
    const candidate = join(home, "bin", process.platform === "win32" ? "jfr.exe" : "jfr");
    if (existsSync(candidate)) return candidate;
  }
  return "jfr";
}

// ─── Per-thread aggregation ────────────────────────────────────────────────

export interface PerThreadStats {
  samples: number;
  idleSamples: number;
  leafFrames: Map<string, number>;
  subsystems: Map<string, number>;
  /** inclusive frame counts (each stack frame contributes its event weight) */
  inclusiveFrames: Map<string, number>;
  /** leaf-only frame counts (top-of-stack only) */
  leafOnlyFrames: Map<string, number>;
}

export interface SubsystemStats {
  samples: number;
  frames: Map<string, number>;
}

export interface AggregateResult {
  totalSamples: number;
  activeSamples: number;
  idleSamples: number;
  threadTotals: Map<string, PerThreadStats>;
  subsystemTotals: Map<string, SubsystemStats>;
}

/**
 * One-pass aggregator. Streams every event into per-thread + per-subsystem
 * structures. All downstream tools can consume the same `AggregateResult`.
 *
 * `includeIdleInSubsystems`: idle events have no app-code frame, so they are
 * skipped from subsystem accounting by default.
 */
export function aggregatePerThread(opts: { packageDepth: number; includeIdleInSubsystems: boolean }) {
  const threadTotals = new Map<string, PerThreadStats>();
  const subsystemTotals = new Map<string, SubsystemStats>();
  let totalSamples = 0;
  let activeSamples = 0;
  let idleSamples = 0;

  function addToThread(
    thread: string,
    weight: number,
    frames: string[],
    isIdle: boolean,
    eventSubsystems: IterableIterator<string>,
  ): void {
    let t = threadTotals.get(thread);
    if (!t) {
      t = {
        samples: 0,
        idleSamples: 0,
        leafFrames: new Map(),
        subsystems: new Map(),
        inclusiveFrames: new Map(),
        leafOnlyFrames: new Map(),
      };
      threadTotals.set(thread, t);
    }
    t.samples += weight;
    if (isIdle) t.idleSamples += weight;
    if (frames.length > 0) {
      const leaf = frames[0];
      t.leafFrames.set(leaf, (t.leafFrames.get(leaf) ?? 0) + weight);
      t.leafOnlyFrames.set(leaf, (t.leafOnlyFrames.get(leaf) ?? 0) + weight);
    }
    // Inclusive: every distinct frame in the stack gets the event's weight once.
    const seen = new Set<string>();
    for (const f of frames) {
      if (seen.has(f)) continue;
      seen.add(f);
      t.inclusiveFrames.set(f, (t.inclusiveFrames.get(f) ?? 0) + weight);
    }
    for (const key of eventSubsystems) {
      t.subsystems.set(key, (t.subsystems.get(key) ?? 0) + weight);
    }
  }

  function addToSubsystems(weight: number, framesByBucket: Map<string, Set<string>>): void {
    for (const [key, frames] of framesByBucket) {
      let s = subsystemTotals.get(key);
      if (!s) {
        s = { samples: 0, frames: new Map() };
        subsystemTotals.set(key, s);
      }
      s.samples += weight;
      for (const f of frames) s.frames.set(f, (s.frames.get(f) ?? 0) + weight);
    }
  }

  return {
    onEvent(ev: RawSampleEvent): void {
      const w = ev.samples || 1;
      totalSamples += w;
      const buckets = subsystemsForStack(ev.frames, opts.packageDepth);
      const idle = buckets.size === 0;
      if (idle) idleSamples += w;
      else activeSamples += w;
      addToThread(ev.thread, w, ev.frames, idle, buckets.keys());
      if (!idle || opts.includeIdleInSubsystems) addToSubsystems(w, buckets);
    },
    result(): AggregateResult {
      return { totalSamples, activeSamples, idleSamples, threadTotals, subsystemTotals };
    },
  };
}

/**
 * Quick run-and-aggregate convenience wrapper. Use this in tools that don't
 * need to fork their own event iteration.
 */
export async function runAggregate(
  filepath: string,
  opts: {
    events?: readonly string[];
    stackDepth?: number;
    packageDepth?: number;
    includeIdleInSubsystems?: boolean;
  } = {},
): Promise<{ events: number; result: AggregateResult; elapsedMs: number }> {
  const t0 = Date.now();
  const agg = aggregatePerThread({
    packageDepth: opts.packageDepth ?? 3,
    includeIdleInSubsystems: opts.includeIdleInSubsystems ?? false,
  });
  const { eventCount } = await runJfrTextSamples(
    filepath,
    opts.events ?? DEFAULT_WALL_CLOCK_EVENTS,
    opts.stackDepth ?? 64,
    agg.onEvent,
  );
  return { events: eventCount, result: agg.result(), elapsedMs: Date.now() - t0 };
}

// ─── Call-tree synthesis ───────────────────────────────────────────────────

export interface SynthCallNode {
  /** Frame string. Null on the synthetic root. */
  frame: string | null;
  /** Cumulative event weight passing through this node. */
  value: number;
  /** Children keyed by frame string for fast merge during stack inserts. */
  children: Map<string, SynthCallNode>;
}

/**
 * Build a per-thread synthetic call tree from streamed events. Each event's
 * leaf-first frame stack becomes a root → leaf path; weights accumulate at
 * every depth. Self time = node.value − sum(child.value).
 *
 * Returns one root per thread. Call tree mirrors what the IDE Profiler would
 * build, minus folding (project / non-project / recursive) since that's a
 * decision made at parse time inside the IDE.
 */
export function buildPerThreadTrees(events: Iterable<RawSampleEvent>): Map<string, SynthCallNode> {
  const trees = new Map<string, SynthCallNode>();
  for (const ev of events) {
    let root = trees.get(ev.thread);
    if (!root) {
      root = { frame: null, value: 0, children: new Map() };
      trees.set(ev.thread, root);
    }
    root.value += ev.samples;
    // jfr prints leaf-first. Walk reversed (caller→callee) into the tree.
    let node = root;
    for (let i = ev.frames.length - 1; i >= 0; i--) {
      const frame = ev.frames[i];
      let child = node.children.get(frame);
      if (!child) {
        child = { frame, value: 0, children: new Map() };
        node.children.set(frame, child);
      }
      child.value += ev.samples;
      node = child;
    }
  }
  return trees;
}

export function selfValueOf(node: SynthCallNode): number {
  let childSum = 0;
  for (const c of node.children.values()) childSum += c.value;
  return node.value - childSum;
}
