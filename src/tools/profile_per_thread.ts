import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profilePerThreadSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to query: wallClockCpu (running threads), wallClockTotal (running+sleeping), cpu (jdk.ExecutionSample only, no wall-clock merge), memoryAllocations."),
  threadFilter: z
    .string()
    .optional()
    .default("*")
    .describe("Glob pattern matched against thread names. '*' matches all. Examples: 'AWT-EventQueue*', 'DefaultDispatcher-worker-*'."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Top frames per group, both inclusive and leaf. Default 10."),
});

export type ProfilePerThreadInput = z.infer<typeof profilePerThreadSchema>;

/**
 * Per-thread call tree extraction. Threads are auto-grouped into EDT / idePool /
 * dispatcher / fjPool / indexing / telemetry / gc / other; each group reports
 * its hot inclusive frames (anywhere in stack) and leaf frames (self time).
 *
 * High-fidelity path (when a JetBrains IDE with the Profiler Ultimate plugin is
 * reachable via the JetDesk IDE bridge): delegates to extract-per-thread.kts,
 * which reads the IDE's already-parsed call tree (state-aware, wall-clock-
 * interval-scaled, JBR-aware).
 *
 * Local-CLI fallback: not implemented yet — returns a structured error pointing
 * at the bridge requirement and the existing flat-aggregate tools.
 */
export async function profilePerThread(input: ProfilePerThreadInput): Promise<string> {
  const filepath = resolveProfilePath(input.filepath);
  if (!existsSync(filepath)) {
    return formatError(
      `File not found: ${filepath}`,
      "FILE_NOT_FOUND",
      "Create a recording with start_profiling/stop_profiling, or pass an absolute .jfr path.",
    );
  }

  const ide = await getIdeBridge();
  if (ide) {
    try {
      const { open, result } = await ide.runner.runSnapshotScript(
        ide.bridge,
        "extract-per-thread.kts",
        filepath,
        {
          topN: String(input.topN),
          threadFilter: input.threadFilter,
          treeId: input.treeId,
        },
        { taskId: "javaperf:profile_per_thread", reason: `profile_per_thread on ${filepath}` },
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
        "Open the .jfr in the IntelliJ Profiler tool window manually, then retry. Or use the flat-aggregate tools (profile_time, profile_frequency).",
      );
    }
  }

  return formatError(
    "profile_per_thread requires the JetDesk IDE bridge.",
    "BRIDGE_REQUIRED",
    "This tool needs a running JetBrains IDE reachable via mcp-steroid. For raw flat aggregation, use profile_time (cumulative) or profile_frequency (leaf) instead.",
  );
}
