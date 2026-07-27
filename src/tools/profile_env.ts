import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge, summarizeBridgeError } from "../utils/ide-bridge.js";
import {
  asString,
  firstRow,
  parseFlagSize,
  readJfrEventRows,
} from "../utils/jfr-event-rows.js";

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
 * Reads JFR events directly (no Profiler tool-window dependency).
 *
 * Bridge mode (IDE reachable): JMC via extract-env.kts (includes IDE name/build).
 * CLI fallback: jfr print --json. The `ide` field is null in CLI mode.
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

  let bridgeError: string | undefined;
  const ide = await getIdeBridge();
  if (ide) {
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
      bridgeError = summarizeBridgeError((err as Error).message);
    }
  }

  try {
    const out = await computeEnvCli(filepath);
    return JSON.stringify({ source: "jfr-cli", ...(bridgeError ? { degradedFrom: "ide-bridge", bridgeError } : {}), snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function computeEnvCli(filepath: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const rows = await readJfrEventRows(filepath, [
    "jdk.JVMInformation",
    "jdk.OSInformation",
    "jdk.CPUInformation",
    "jdk.GCConfiguration",
    "jdk.GCHeapConfiguration",
    "jdk.InitialSystemProperty",
    "jdk.ActiveSetting",
    "jdk.ActiveRecording",
  ]);
  const loadMs = Date.now() - t0;

  const jvm = firstRow(rows, "jdk.JVMInformation") ?? {};
  const os = firstRow(rows, "jdk.OSInformation") ?? {};
  const cpu = firstRow(rows, "jdk.CPUInformation") ?? {};
  const gc = firstRow(rows, "jdk.GCConfiguration") ?? {};
  const gcHeap = firstRow(rows, "jdk.GCHeapConfiguration") ?? {};
  const recording = firstRow(rows, "jdk.ActiveRecording") ?? {};

  const sysProps: Record<string, string | null> = {};
  for (const p of rows.get("jdk.InitialSystemProperty") ?? []) {
    const k = asString(p.key);
    if (k) sysProps[k] = asString(p.value);
  }

  const activeSettings = rows.get("jdk.ActiveSetting") ?? [];
  const profilerEngine = activeSettings.find((s) => asString(s.name) === "engine");
  const profilerIntervalRow = activeSettings.find((s) => {
    const n = asString(s.name) ?? "";
    return n.startsWith("used") && n.endsWith("Interval");
  });

  const jvmArgs = asString(jvm.jvmArguments) ?? "";

  return {
    loadMs,
    os: { raw: asString(os.osVersion) },
    cpu: {
      description: asString(cpu.description) ?? asString(cpu.cpu),
      sockets: asString(cpu.sockets),
      cores: asString(cpu.cores),
      hwThreads: asString(cpu.hwThreads),
    },
    jvm: {
      name: asString(jvm.jvmName),
      version: asString(jvm.jvmVersion),
      jvmArguments: asString(jvm.jvmArguments),
      javaArguments: asString(jvm.javaArguments),
      pid: asString(jvm.pid),
      jvmStartTime: asString(jvm.jvmStartTime),
    },
    heap: {
      xmxBytes: parseFlagSize(jvmArgs, "-Xmx"),
      xmsBytes: parseFlagSize(jvmArgs, "-Xms"),
      youngCollector: asString(gc.youngCollector),
      oldCollector: asString(gc.oldCollector),
      initialHeapBytes: asString(gcHeap.initialSize),
      maxHeapBytes: asString(gcHeap.maxSize),
    },
    ide: null,
    profiler: {
      engine: profilerEngine ? asString(profilerEngine.value) : null,
      interval: profilerIntervalRow ? asString(profilerIntervalRow.value) : null,
      recordingName: asString(recording.name),
    },
    systemPropertyCount: Object.keys(sysProps).length,
    systemProperties: sysProps,
  };
}
