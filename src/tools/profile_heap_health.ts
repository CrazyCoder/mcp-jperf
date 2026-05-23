import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profileHeapHealthSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
});

export type ProfileHeapHealthInput = z.infer<typeof profileHeapHealthSchema>;

/**
 * Heap health summary from JFR GC events. Returns:
 *   - xmxMb / xmxSource (from JVM info or -Xmx flag)
 *   - GC cadence + count
 *   - heap used after each GC (recovery floor)
 *   - latest after-GC usage as % of xmx
 *   - average / max CPU load
 *   - one-word assessment: Healthy / Moderate / High / Critical
 *
 * Use to answer: "is the heap healthy or is the process under memory pressure?"
 * Reads JFR events directly via JMC (no Profiler tool-window dependency) so
 * runs faster than the call-tree tools (~1-3s typically).
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
 */
export async function profileHeapHealth(input: ProfileHeapHealthInput): Promise<string> {
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
      "profile_heap_health requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid.",
    );
  }

  try {
    const result = await ide.runner.runDirectScript(
      ide.bridge,
      "extract-heap-health.kts",
      filepath,
      {},
      { taskId: "javaperf:profile_heap_health", reason: `profile_heap_health on ${filepath}` },
    );
    return JSON.stringify(
      {
        source: "ide-bridge",
        ide: { name: ide.bridge.ideName, build: ide.bridge.ideBuild, project: ide.bridge.projectName },
        snapshot: { file: filepath },
        ...(result as object),
      },
      null,
      2,
    );
  } catch (err) {
    return formatError(
      `IDE bridge call failed: ${(err as Error).message}`,
      "BRIDGE_ERROR",
      "Verify the IDE is reachable via mcp-steroid and the .jfr file is readable.",
    );
  }
}
