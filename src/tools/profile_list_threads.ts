import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

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
    .describe("Which tree's per-thread sample totals to use for ranking. Default wallClockCpu."),
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
 * Fast thread inventory for an open snapshot. Returns:
 *   - groupSummary: per-group thread count + total samples + % of total
 *     (edt, idePool, dispatcher, fjPool, indexing, telemetry, gc, other)
 *   - threads: top-N threads by sample count, each with its hottest-leaf frame
 *     (the deepest method along the hottest-child chain — a one-line summary
 *     of what the thread was actually doing).
 *
 * Cheap first-look tool: ~1-2s on a typical snapshot, no deep aggregation.
 * Use to identify which threads are worth drilling into with profile_per_thread
 * or profile_call_tree.
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
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

  const ide = await getIdeBridge();
  if (!ide) {
    return formatError(
      "profile_list_threads requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid.",
    );
  }

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
    return formatError(
      `IDE bridge call failed: ${(err as Error).message}`,
      "BRIDGE_ERROR",
      "Open the .jfr in the IntelliJ Profiler tool window manually, then retry.",
    );
  }
}
