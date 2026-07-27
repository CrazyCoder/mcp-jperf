import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge, summarizeBridgeError } from "../utils/ide-bridge.js";
import {
  buildPerThreadTrees,
  classifyThreadGroup,
  DEFAULT_WALL_CLOCK_EVENTS,
  runJfrTextSamples,
  type RawSampleEvent,
  type SynthCallNode,
} from "../utils/jfr-cli-aggregator.js";

export const profileListThreadsSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which tree's per-thread sample totals to use for ranking. Default wallClockCpu. CLI mode ignores this and uses raw sample counts."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(30)
    .describe("Number of top threads (by sample count) to return individually. The full group summary covers all threads. Default 30."),
});

export type ProfileListThreadsInput = z.infer<typeof profileListThreadsSchema>;

/**
 * Fast thread inventory. Returns:
 *   - groupSummary: per-group thread count + total samples + % of total
 *     (edt, idePool, dispatcher, fjPool, indexing, telemetry, gc, other)
 *   - threads: top-N threads by sample count, each with its hottest-leaf frame
 *     (the deepest method along the hottest-child chain — a one-line summary
 *     of what the thread was actually doing).
 *
 * Bridge mode (IDE reachable): uses the IDE's already-parsed call tree (state-
 * aware, wall-clock-interval-scaled). Metric = wallClockMs|bytes|samples.
 * CLI fallback: synthesizes a per-thread tree from streamed JFR samples.
 * Metric = samples; numbers differ from bridge mode but ranking is similar.
 */
export async function profileListThreads(input: ProfileListThreadsInput): Promise<string> {
  const filepath = resolveProfilePath(input.filepath);
  if (!existsSync(filepath)) {
    return formatError(
      `File not found: ${filepath}`,
      "FILE_NOT_FOUND",
      "Create a recording with start_profiling/stop_profiling, or pass an absolute .jfr path.",
    );
  }

  let bridgeError: string | undefined;
  const ide = await getIdeBridge();
  if (ide) {
    try {
      const { open, result } = await ide.runner.runSnapshotScript(
        ide.bridge,
        "extract-list-threads.kts",
        filepath,
        {
          treeId: input.treeId,
          topN: String(input.topN),
        },
        { taskId: "javaperf:profile_list_threads", reason: `profile_list_threads on ${filepath}` },
      );
      return JSON.stringify(
        {
          source: "ide-bridge",
          ide: { name: ide.bridge.ideName, build: ide.bridge.ideBuild, project: ide.bridge.projectName },
          snapshot: { state: (open as { state?: string })?.state, file: filepath },
          ...(result as object),
        },
        null,
        2,
      );
    } catch (err) {
      bridgeError = summarizeBridgeError((err as Error).message);
    }
  }

  try {
    const out = await computeListThreadsCli(filepath, input.topN);
    return JSON.stringify({ source: "jfr-cli", ...(bridgeError ? { degradedFrom: "ide-bridge", bridgeError } : {}), snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function computeListThreadsCli(filepath: string, topN: number): Promise<Record<string, unknown>> {
  // We need both per-thread sample counts (cheap) and the hottest-leaf chain
  // (requires the synthesized tree). One streaming pass that builds both.
  const events: RawSampleEvent[] = [];
  const { eventCount } = await runJfrTextSamples(filepath, DEFAULT_WALL_CLOCK_EVENTS, 64, (ev) => {
    events.push(ev);
  });
  void eventCount;

  const trees = buildPerThreadTrees(events);
  let totalSamples = 0;
  const groupTotals = new Map<string, number>();
  const groupCounts = new Map<string, number>();

  interface Row {
    name: string;
    group: string;
    samples: number;
    hottestLeaf: string | null;
  }
  const rows: Row[] = [];
  for (const [name, root] of trees) {
    const samples = root.value;
    const group = classifyThreadGroup(name);
    rows.push({ name, group, samples, hottestLeaf: hottestLeafChain(root) });
    totalSamples += samples;
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + samples);
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }

  rows.sort((a, b) => b.samples - a.samples);

  const groupSummary = [...groupTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([group, samples]) => ({
      group,
      threadCount: groupCounts.get(group) ?? 0,
      value: samples,
      pctOfTotal: totalSamples > 0 ? +(samples / totalSamples * 100).toFixed(2) : 0,
    }));

  const threads = rows.slice(0, topN).map((r) => ({
    name: r.name,
    group: r.group,
    value: r.samples,
    pctOfTotal: totalSamples > 0 ? +(r.samples / totalSamples * 100).toFixed(2) : 0,
    hottestLeaf: r.hottestLeaf,
  }));

  return {
    treeId: null,
    metric: "samples",
    totalThreadsInSnapshot: trees.size,
    totalValue: totalSamples,
    groupSummary,
    threads,
  };
}

/** Walk hottest child until a single branch no longer dominates (or runs out). */
function hottestLeafChain(node: SynthCallNode): string | null {
  let cur: SynthCallNode = node;
  let last: string | null = null;
  let guard = 0;
  while (guard++ < 200) {
    let best: SynthCallNode | null = null;
    for (const c of cur.children.values()) {
      if (!best || c.value > best.value) best = c;
    }
    if (!best) return last;
    if (best.frame) last = best.frame;
    cur = best;
  }
  return last;
}
