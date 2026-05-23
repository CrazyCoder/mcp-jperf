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
  discoverIde(opts?: { prefer?: "monorepo" | "cwd" | "any"; cwd?: string }): Promise<IdeBridgeHandle | null>;
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
    cachedHandle = await loaded.bridge.discoverIde({ prefer: "monorepo" });
  }
  if (!cachedHandle) return null;
  return { bridge: cachedHandle, runner: loaded.runner };
}

/** Test seam: clear the cache so the next call re-discovers. */
export function _resetBridgeCache(): void {
  cached = undefined;
  cachedHandle = undefined;
}
