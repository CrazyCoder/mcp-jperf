import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";
import { runJfr } from "../utils/jdk.js";

export const profileDescribeSnapshotSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
});

export type ProfileDescribeSnapshotInput = z.infer<typeof profileDescribeSnapshotSchema>;

/**
 * Discovery tool. Bridge mode returns which call trees the snapshot contains,
 * each tree's metric (wallClockMs / bytes / samples), thread count per tree,
 * and the grand total value. Use as a cheap first call before invoking the
 * deeper tools.
 *
 * CLI fallback (no IDE) reports the raw event-type inventory from
 * `jfr summary` instead — different semantics: event types and their counts
 * rather than the IDE's available trees. Use the inventory to decide whether
 * the snapshot has profiler.WallClock* events (Profiler-style) or only
 * jdk.ExecutionSample (legacy CPU mode). The `mode` field distinguishes them.
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
  if (ide) {
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
          mode: "ide",
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
    const out = await describeCli(filepath);
    return JSON.stringify({ source: "jfr-cli", mode: "cli", snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function describeCli(filepath: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const raw = await runJfr(["summary", filepath]);
  const loadMs = Date.now() - t0;

  const eventTypes: Array<{ name: string; count: number }> = [];
  const meta: Record<string, string> = {};

  // jfr summary output looks like:
  //   Recording started: <ts>
  //   Recording duration: <ms>
  //   ...
  //
  //    Event Type                            Count   Size (bytes)
  //   =================================================================
  //    jdk.ActiveRecording                       1            123
  //    jdk.JVMInformation                        1           4096
  //    profiler.WallClockSample              12345         876543
  for (const line of raw.split(/\r?\n/)) {
    const metaMatch = line.match(/^\s*([A-Z][\w\s]+):\s+(.+?)\s*$/);
    if (metaMatch && !line.includes("===")) {
      meta[metaMatch[1].trim()] = metaMatch[2].trim();
      continue;
    }
    const rowMatch = line.match(/^\s*([\w.$_]+)\s+(\d+)\s+\d+\s*$/);
    if (rowMatch) {
      eventTypes.push({ name: rowMatch[1], count: Number(rowMatch[2]) });
    }
  }

  eventTypes.sort((a, b) => b.count - a.count);
  const hasWallClock = eventTypes.some((e) => e.name.startsWith("profiler.WallClock"));
  const hasExecutionSample = eventTypes.some((e) => e.name === "jdk.ExecutionSample");
  const hasAllocation = eventTypes.some(
    (e) => e.name === "jdk.ObjectAllocationInNewTLAB" || e.name === "jdk.ObjectAllocationOutsideTLAB",
  );
  const totalEvents = eventTypes.reduce((a, e) => a + e.count, 0);

  return {
    loadMs,
    recordingMeta: meta,
    totalEventTypes: eventTypes.length,
    totalEvents,
    eventTypes,
    capabilities: {
      wallClockSamples: hasWallClock,
      executionSamples: hasExecutionSample,
      allocationSamples: hasAllocation,
    },
  };
}
