import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

export const profileSubsystemScanSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to scan. wallClockCpu surfaces hot CPU subsystems; wallClockTotal includes blocked/waiting time."),
  packageDepth: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .default(3)
    .describe("Number of package segments used as the subsystem key (e.g. depth=3 → 'com.intellij.spring'). Default 3."),
  topSubsystems: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
    .describe("Top subsystems to return in the breakdown. Default 25."),
  topPerBucket: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(8)
    .describe("Per subsystem: top methods to include in its details. Default 8."),
  highlightThresholdPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .default(20)
    .describe("Subsystems above this % of total samples are surfaced in the 'headlineSubsystems' field for quick triage. Default 20."),
});

export type ProfileSubsystemScanInput = z.infer<typeof profileSubsystemScanSchema>;

/**
 * Auto-grouped subsystem breakdown of a snapshot. Subsystems are derived from
 * each frame's package prefix at `packageDepth` segments (e.g. 'com.intellij.spring',
 * 'org.jetbrains.kotlin.idea') — no hardcoded keyword list. Stdlib / runtime
 * (java/kotlin/jdk/...) is excluded; whatever's hot in the snapshot surfaces.
 *
 * Use to spot a dominant subsystem behind a freeze without prior hypotheses
 * (e.g. Spring AOP processing 27% of samples, an obscure plugin namespace
 * holding 40%). Inclusive counting — every distinct subsystem in a stack
 * counted once per event.
 *
 * Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.
 */
export async function profileSubsystemScan(input: ProfileSubsystemScanInput): Promise<string> {
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
      "profile_subsystem_scan requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid. The raw-JFR scan-snapshot.js script in scripts/javaperf/ approximates this view without an IDE.",
    );
  }

  try {
    const { open, result } = await ide.runner.runSnapshotScript(
      ide.bridge,
      "extract-subsystem-scan.kts",
      filepath,
      {
        treeId: input.treeId,
        packageDepth: String(input.packageDepth),
        topSubsystems: String(input.topSubsystems),
        topPerBucket: String(input.topPerBucket),
        highlightThresholdPct: String(input.highlightThresholdPct),
      },
      { taskId: "javaperf:profile_subsystem_scan", reason: `profile_subsystem_scan on ${filepath}` },
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
