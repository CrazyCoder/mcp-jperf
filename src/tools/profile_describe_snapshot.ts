import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profileDescribeSnapshotSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
});

export type ProfileDescribeSnapshotInput = z.infer<typeof profileDescribeSnapshotSchema>;

/**
 * Discovery tool: returns which call trees the snapshot contains, each tree's
 * metric (wallClockMs / bytes / samples), thread count per tree, and the
 * grand total value. Use as a cheap first call to learn what the snapshot
 * can answer before invoking the deeper tools.
 *
 * If a snapshot was recorded without memory allocation events, for example,
 * `memoryAllocations` won't appear in `availableTrees` — and any tool call
 * with `treeId="memoryAllocations"` will return a clean error listing what
 * IS available.
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
 */
export async function profileDescribeSnapshot(input: ProfileDescribeSnapshotInput): Promise<string> {
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
      "profile_describe_snapshot requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid.",
    );
  }

  try {
    const { open, result } = await ide.runner.runSnapshotScript(
      ide.bridge,
      "extract-snapshot-info.kts",
      filepath,
      {},
      { taskId: "javaperf:profile_describe_snapshot", reason: `profile_describe_snapshot on ${filepath}` },
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
