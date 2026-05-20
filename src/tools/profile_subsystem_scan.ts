import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";
import { runAggregate } from "../utils/jfr-cli-aggregator.js";

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
 * Bridge mode (IDE reachable): traverses the IDE's per-thread call trees;
 * metric = wallClockMs|bytes|samples.
 * CLI fallback: streams raw JFR samples; metric = samples.
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
  if (ide) {
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

  try {
    const out = await computeSubsystemScanCli(
      filepath,
      input.packageDepth,
      input.topSubsystems,
      input.topPerBucket,
      input.highlightThresholdPct,
    );
    return JSON.stringify({ source: "jfr-cli", snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function computeSubsystemScanCli(
  filepath: string,
  packageDepth: number,
  topSubsystems: number,
  topPerBucket: number,
  highlightThresholdPct: number,
): Promise<Record<string, unknown>> {
  const { result } = await runAggregate(filepath, { packageDepth });

  const totalValue = result.activeSamples;
  const rows = [...result.subsystemTotals.entries()]
    .map(([name, s]) => {
      const pct = totalValue > 0 ? (s.samples / totalValue) * 100 : 0;
      const topFrames = [...s.frames.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topPerBucket)
        .map(([method, value]) => ({ method, value }));
      return {
        name,
        inclusiveValue: s.samples,
        pctOfTotal: +pct.toFixed(2),
        topFrames,
      };
    })
    .sort((a, b) => b.inclusiveValue - a.inclusiveValue);

  const headline = rows
    .filter((r) => r.pctOfTotal >= highlightThresholdPct)
    .map((r) => `${r.name}=${r.pctOfTotal.toFixed(1)}%`);

  const topSubsystemsMap: Record<string, unknown> = {};
  for (const r of rows.slice(0, topSubsystems)) {
    topSubsystemsMap[r.name] = {
      inclusiveValue: r.inclusiveValue,
      pctOfTotal: r.pctOfTotal,
      topFrames: r.topFrames,
    };
  }

  return {
    treeId: null,
    metric: "samples",
    totalValue,
    nodesWalked: null, // CLI mode aggregates events, not tree nodes
    totalSubsystems: result.subsystemTotals.size,
    packageDepth,
    highlightThresholdPct,
    headlineSubsystems: headline,
    topSubsystems: topSubsystemsMap,
  };
}
