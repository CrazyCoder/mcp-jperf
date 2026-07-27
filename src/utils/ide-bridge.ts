/**
 * IDE bridge loader. When this jperf is vendored under JetDesk, the JS bridge
 * library sits at a known relative path. We dynamically import it once and
 * cache the result. When not vendored (standalone npm install), the file is
 * absent and `getIdeBridge()` returns null forever — callers fall back to
 * local jfr-CLI parsing.
 *
 * Bridge file: scripts/lib/ide-bridge.js  (CommonJS, exports discoverIde et al.)
 * Snapshot runner: scripts/steroid/snapshot/runner.js  (separate concern)
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// From tools/mcp/javaperf/dist/utils/ide-bridge.js to scripts/lib/ide-bridge.js
const BRIDGE_PATH = resolve(HERE, "../../../../../scripts/lib/ide-bridge.js");
const SNAPSHOT_RUNNER_PATH = resolve(HERE, "../../../../../scripts/steroid/snapshot/runner.js");

export interface IdeBridgeHandle {
  url: string;
  host: string;
  port: number;
  name: string;
  projectName: string;
  ideName?: string;
  ideVersion?: string;
  ideBuild?: string;
  projects: Array<{ name: string; path: string }>;
}

export interface IdeBridgeModule {
  discoverIde(opts?: {
    prefer?: "monorepo" | "cwd" | "non-monorepo" | "any";
    cwd?: string;
    /** Pin a single instance by port; skips discovery and scoring entirely. */
    port?: number;
  }): Promise<IdeBridgeHandle | null>;
  executeScript(bridge: IdeBridgeHandle, scriptText: string, params?: Record<string, string>, opts?: unknown): Promise<unknown>;
  mcpInit(host: string, port: number): Promise<{ sessionId: string; serverInfo: unknown }>;
}

export interface SnapshotRunnerModule {
  runSnapshotScript(
    bridge: IdeBridgeHandle,
    scriptName: string,
    snapshotPath: string,
    params?: Record<string, string>,
    opts?: unknown,
  ): Promise<{ open: unknown; result: unknown }>;
  runDirectScript(
    bridge: IdeBridgeHandle,
    scriptName: string,
    snapshotPath: string,
    params?: Record<string, string>,
    opts?: unknown,
  ): Promise<unknown>;
}

type LoadResult = { bridge: IdeBridgeModule; runner: SnapshotRunnerModule } | null;

let cached: LoadResult | undefined;

/**
 * Lazily load the bridge + snapshot runner. Returns null if files are absent
 * (e.g. jperf installed standalone) or if a load error occurs.
 */
export async function loadBridge(): Promise<LoadResult> {
  if (cached !== undefined) return cached;
  // Test seam: skip bridge discovery entirely when the env flag is set.
  if (process.env.JAVAPERF_DISABLE_BRIDGE === "1") {
    cached = null;
    return cached;
  }
  if (!existsSync(BRIDGE_PATH) || !existsSync(SNAPSHOT_RUNNER_PATH)) {
    cached = null;
    return cached;
  }
  try {
    // CommonJS modules loaded from ESM expose named exports both on the
    // namespace and under `.default` (depending on Node version). Pick the
    // shape that exposes the function we expect.
    const bridgeMod: Record<string, unknown> = await import(pathToFileURL(BRIDGE_PATH).href);
    const runnerMod: Record<string, unknown> = await import(pathToFileURL(SNAPSHOT_RUNNER_PATH).href);
    const bridge = (typeof bridgeMod.discoverIde === "function" ? bridgeMod : bridgeMod.default) as IdeBridgeModule;
    const runner = (typeof runnerMod.runSnapshotScript === "function" ? runnerMod : runnerMod.default) as SnapshotRunnerModule;
    if (!bridge?.discoverIde || !runner?.runSnapshotScript) {
      throw new Error("Bridge module shape unexpected: missing discoverIde / runSnapshotScript");
    }
    cached = { bridge, runner };
  } catch (err) {
    process.stderr.write(`[javaperf] IDE bridge unavailable: ${(err as Error).message}\n`);
    cached = null;
  }
  return cached;
}

let cachedHandle: IdeBridgeHandle | null | undefined;

/**
 * Discover the IDE once per process. Subsequent calls return the cached handle.
 * Returns null if no bridge library is present, or no reachable IDE is found.
 */
export async function getIdeBridge(): Promise<{ bridge: IdeBridgeHandle; runner: SnapshotRunnerModule } | null> {
  const loaded = await loadBridge();
  if (!loaded) return null;
  if (cachedHandle === undefined) {
    // JETDESK_JAVAPERF_IDE_PORT pins a specific IDE instead of letting the
    // scoring heuristic pick. Needed when the highest-scoring IDE (usually the
    // monorepo one) is present but unable to run scripts — otherwise the only
    // way out is to close that IDE.
    const pinned = Number(process.env.JETDESK_JAVAPERF_IDE_PORT);
    cachedHandle = Number.isInteger(pinned) && pinned > 0
      ? await loaded.bridge.discoverIde({ port: pinned })
      : await loaded.bridge.discoverIde({ prefer: "monorepo" });
  }
  if (!cachedHandle) return null;
  return { bridge: cachedHandle, runner: loaded.runner };
}

/** Test seam: clear the cache so the next call re-discovers. */
export function _resetBridgeCache(): void {
  cached = undefined;
  cachedHandle = undefined;
}

/**
 * Collapse a bridge failure into one actionable line.
 *
 * Script-compilation failures arrive as a wall of repeated Kotlin compiler
 * errors — one per module on the IDE classpath, often 200+ lines. Most MCP
 * clients truncate that, so the visible head ends up being the least
 * informative part of it (a `kotlin-script-runtime` module name) rather than
 * the actual cause.
 */
export function summarizeBridgeError(raw: string): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "unknown bridge failure";

  // The plugin's bundled kotlinc is too far from the IDE's bundled Kotlin.
  // Kotlin reads class metadata at most +1 minor ahead of the compiler.
  const meta = msg.match(/metadata is (\d+\.\d+(?:\.\d+)?), expected version is (\d+\.\d+(?:\.\d+)?)/);
  if (meta) {
    const [, ideKotlin, compilerKotlin] = meta;
    const modules = (msg.match(/incompatible version of Kotlin/g) ?? []).length;
    return (
      `Kotlin metadata mismatch: this IDE bundles Kotlin ${ideKotlin}, but the mcp-steroid ` +
      `bundled kotlinc only reads up to ${compilerKotlin}` +
      (modules > 1 ? ` (${modules} modules rejected)` : "") +
      `. The IDE cannot compile bridge scripts at all. Update the mcp-steroid plugin, or ` +
      `point javaperf at a different IDE with JETDESK_JAVAPERF_IDE_PORT=<port>.`
    );
  }

  const lines = msg.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length > 6) {
    return `${lines[0].slice(0, 300)} … (+${lines.length - 1} more lines)`;
  }
  return msg.length > 600 ? `${msg.slice(0, 600)} …` : msg;
}
