import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profileEdtHotspotSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to query. For freeze triage start with wallClockTotal (includes blocked time); for hot-CPU paths use wallClockCpu."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Number of leaf (self-time) hot frames to return across all EDT threads. Default 20."),
});

export type ProfileEdtHotspotInput = z.infer<typeof profileEdtHotspotSchema>;

/**
 * EDT-focused hot path + leaf hotspots. Returns:
 *   - hotPath: hierarchical descent from the EDT root following the hottest
 *     child at each step until a single branch no longer dominates (<30% of
 *     parent). Best for "what is the EDT actually doing during this freeze?"
 *   - leaves: top-N self-time frames across all EDT threads (exclusive hot spots).
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
 */
export async function profileEdtHotspot(input: ProfileEdtHotspotInput): Promise<string> {
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
      "profile_edt_hotspot requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid. As a substitute, run profile_per_thread with threadFilter='AWT-EventQueue*' for a less focused EDT view.",
    );
  }

  try {
    const { open, result } = await ide.runner.runSnapshotScript(
      ide.bridge,
      "extract-edt-hotspots.kts",
      filepath,
      {
        topN: String(input.topN),
        treeId: input.treeId,
      },
      { taskId: "javaperf:profile_edt_hotspot", reason: `profile_edt_hotspot on ${filepath}` },
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
