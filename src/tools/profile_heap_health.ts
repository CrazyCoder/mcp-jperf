import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge, summarizeBridgeError } from "../utils/ide-bridge.js";
import {
  firstRow,
  parseBytes,
  parseFlagSize,
  parsePercent,
  parseTimestampMs,
  readJfrEventRows,
} from "../utils/jfr-event-rows.js";

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
 * Reads JFR events directly (no Profiler tool-window dependency).
 *
 * Bridge mode (IDE reachable): JMC via extract-heap-health.kts.
 * CLI fallback: jfr print --json. Same output shape.
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

  let bridgeError: string | undefined;
  const ide = await getIdeBridge();
  if (ide) {
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
      bridgeError = summarizeBridgeError((err as Error).message);
    }
  }

  try {
    const out = await computeHeapHealthCli(filepath);
    return JSON.stringify({ source: "jfr-cli", ...(bridgeError ? { degradedFrom: "ide-bridge", bridgeError } : {}), snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function computeHeapHealthCli(filepath: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const rows = await readJfrEventRows(filepath, [
    "jdk.GCHeapSummary",
    "jdk.G1HeapSummary",
    "jdk.GCHeapConfiguration",
    "jdk.JVMInformation",
    "jdk.CPULoad",
    "jdk.GarbageCollection",
    "jdk.G1GarbageCollection",
    "jdk.YoungGarbageCollection",
    "jdk.OldGarbageCollection",
  ]);
  const loadMs = Date.now() - t0;

  const heapConfig = firstRow(rows, "jdk.GCHeapConfiguration") ?? {};
  const jvm = firstRow(rows, "jdk.JVMInformation") ?? {};
  const jvmArgs = typeof jvm.jvmArguments === "string" ? jvm.jvmArguments : "";

  const fromConfig = parseBytes(heapConfig.maxSize);
  const fromFlag = parseFlagSize(jvmArgs, "-Xmx");
  const maxBytes = fromConfig ?? fromFlag;
  const xmxSource =
    fromConfig !== null
      ? "jdk.GCHeapConfiguration"
      : fromFlag !== null
        ? "-Xmx flag in jvmArguments"
        : "unknown";
  const maxMb = maxBytes !== null ? Math.floor(maxBytes / 1024 / 1024) : null;

  const gcSummaries = rows.get("jdk.GCHeapSummary") ?? [];
  const afterGcRows = gcSummaries.filter((r) => r.when === "After GC");
  const afterGcBytes = afterGcRows
    .map((r) => parseBytes(r.heapUsed))
    .filter((b): b is number => b !== null);

  const timestamps = gcSummaries
    .map((r) => parseTimestampMs(r.startTime))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  let gcCadenceMs = 0;
  if (timestamps.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const d = timestamps[i] - timestamps[i - 1];
      if (d > 0) deltas.push(d);
    }
    if (deltas.length > 0) gcCadenceMs = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
  }

  const cpu = rows.get("jdk.CPULoad") ?? [];
  const jvmSystemSamples = cpu.map((r) => parsePercent(r.jvmSystem)).filter((v): v is number => v !== null);
  const jvmUserSamples = cpu.map((r) => parsePercent(r.jvmUser)).filter((v): v is number => v !== null);
  const avgJvmSystem = jvmSystemSamples.length ? jvmSystemSamples.reduce((a, b) => a + b, 0) / jvmSystemSamples.length : 0;
  const avgJvmUser = jvmUserSamples.length ? jvmUserSamples.reduce((a, b) => a + b, 0) / jvmUserSamples.length : 0;
  const maxJvmSystem = jvmSystemSamples.length ? Math.max(...jvmSystemSamples) : 0;

  const afterPct = maxBytes && maxBytes > 0 && afterGcBytes.length > 0
    ? (afterGcBytes[afterGcBytes.length - 1] / maxBytes) * 100
    : 0;

  const assessment =
    !maxBytes || afterGcBytes.length === 0
      ? "Unknown"
      : afterPct < 50
        ? "Healthy"
        : afterPct < 70
          ? "Moderate"
          : afterPct < 85
            ? "High"
            : "Critical";

  const gcEvents = [
    ...(rows.get("jdk.GarbageCollection") ?? []),
    ...(rows.get("jdk.G1GarbageCollection") ?? []),
  ];

  return {
    loadMs,
    xmxMb: maxMb,
    xmxSource,
    gcSummaryCount: gcSummaries.length,
    afterGcCount: afterGcBytes.length,
    gcCadenceMs,
    afterGcUsedMb: afterGcBytes.map((b) => Math.floor(b / 1024 / 1024)),
    afterGcUsedPctLatest: afterPct,
    garbageCollections: gcEvents.length,
    cpu: {
      samples: cpu.length,
      avgJvmSystemFraction: avgJvmSystem,
      avgJvmUserFraction: avgJvmUser,
      maxJvmSystemFraction: maxJvmSystem,
    },
    assessment,
  };
}
