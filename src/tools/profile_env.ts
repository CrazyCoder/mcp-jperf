import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profileEnvSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
});

export type ProfileEnvInput = z.infer<typeof profileEnvSchema>;

/**
 * Snapshot env metadata: OS, CPU cores, JVM info (version + vendor + JBR flag),
 * JVM arguments (Xmx etc), recording metadata (start time, duration), and
 * the async-profiler settings (sampling interval, wall-clock mode flag).
 *
 * Use when you need context about the captured environment — e.g. "is this
 * Linux Wayland or X11?", "is this JBR?", "what was the configured -Xmx?",
 * "was async-profiler in wall-clock or cpu mode?".
 *
 * Reads JFR events directly via JMC (no Profiler tool-window dependency).
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
 */
export async function profileEnv(input: ProfileEnvInput): Promise<string> {
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
      "profile_env requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid.",
    );
  }

  try {
    const result = await ide.runner.runDirectScript(
      ide.bridge,
      "extract-env.kts",
      filepath,
      {},
      { taskId: "javaperf:profile_env", reason: `profile_env on ${filepath}` },
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
