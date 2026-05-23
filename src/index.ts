#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listJavaProcesses } from "./tools/list_procs.js";
import { startProfiling, startProfilingSchema } from "./tools/start_profiling.js";
import { stopProfiling } from "./tools/stop_profiling.js";
import { analyzeThreads } from "./tools/analyze_threads.js";
import { traceMethod } from "./tools/trace_method.js";
import { parseJfrSummary } from "./tools/parse_jfr.js";
import { profileMemory } from "./tools/profile_memory.js";
import { profileTime } from "./tools/profile_time.js";
import { profileFrequency } from "./tools/profile_frequency.js";
import { heapHistogram } from "./tools/heap_histogram.js";
import { heapLiveHistogramDiff } from "./tools/heap_live_histogram_diff.js";
import { gcEfficiency } from "./tools/gc_efficiency.js";
import { heapDump } from "./tools/heap_dump.js";
import { heapInfo } from "./tools/heap_info.js";
import { vmInfo } from "./tools/vm_info.js";
import { listJfrRecordings } from "./tools/list_jfr_recordings.js";
import { checkDeadlock } from "./tools/check_deadlock.js";
import { profileJfrNetwork } from "./tools/profile_jfr_network.js";
import { profileJfrFileIo } from "./tools/profile_jfr_file_io.js";
import { profileJfrLocks } from "./tools/profile_jfr_locks.js";
import { profileJfrNative } from "./tools/profile_jfr_native.js";
import { nativeMemorySummary } from "./tools/native_memory_summary.js";
import { gcClassStats } from "./tools/gc_class_stats.js";
import { gcFinalizerInfo } from "./tools/gc_finalizer_info.js";
import { compilerCodecache } from "./tools/compiler_codecache.js";
import { compilerQueue } from "./tools/compiler_queue.js";
import { profilePerThread, profilePerThreadSchema } from "./tools/profile_per_thread.js";
import { profileCallTree, profileCallTreeSchema } from "./tools/profile_call_tree.js";
import { profileEdtHotspot, profileEdtHotspotSchema } from "./tools/profile_edt_hotspot.js";
import { profileSubsystemScan, profileSubsystemScanSchema } from "./tools/profile_subsystem_scan.js";
import { profileListThreads, profileListThreadsSchema } from "./tools/profile_list_threads.js";
import { profileDescribeSnapshot, profileDescribeSnapshotSchema } from "./tools/profile_describe_snapshot.js";
import { profileHeapHealth, profileHeapHealthSchema } from "./tools/profile_heap_health.js";
import { profileEnv, profileEnvSchema } from "./tools/profile_env.js";
import { VERSION } from "./version.js";

const server = new McpServer({
  name: "javaperf",
  version: VERSION,
});

server.registerTool(
  "list_java_processes",
  {
    description: "Lists all running Java processes on the machine. Returns an array of objects with pid, mainClass, and args. Use this tool first to discover the target process PID before calling start_profiling or analyze_threads. Data is obtained via jps -l -m.",
    inputSchema: z.object({
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of processes to return in the list. Default: 10. Use higher values if many Java processes are running."),
    }),
  },
  async ({ topN }) => ({
    content: [{ type: "text", text: await listJavaProcesses({ topN }) }],
  })
);

server.registerTool(
  "start_profiling",
  {
    description:
      "Starts JFR on the target PID. Rotates recordings (old_profile.jfr ← new_profile.jfr). Default preset is profile. Optional preset or settingsFile (.jfc, cwd-relative or absolute)—mutually exclusive. Builtin presets may omit socket/I/O/native/locks; use a custom .jfc for jdk.SocketRead/Write, FileRead/Write, JavaMonitorBlocked, jdk.ThreadPark, NativeMethodSample. Then list_jfr_recordings and stop_profiling.",
    inputSchema: startProfilingSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await startProfiling(args) }],
  })
);

server.registerTool(
  "stop_profiling",
  {
    description: "Stops an active JFR recording and saves it to recordings/new_profile.jfr. Use recordings/new_profile.jfr for current data, recordings/old_profile.jfr for previous (before/after comparison).",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java process that has the active recording. Must match the pid used in start_profiling."),
      recordingId: z
        .string()
        .describe("ID of the recording to stop. This is the recordingId returned by start_profiling (e.g. '1' or '2')."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await stopProfiling(args) }],
  })
);

server.registerTool(
  "check_deadlock",
  {
    description: "Checks for Java-level deadlocks in the specified process. Parses jcmd Thread.print output and returns structured JSON: which threads are involved, what locks they hold/wait for, and the deadlock cycle. Use for automated analysis and reports.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await checkDeadlock(args) }],
  })
);

server.registerTool(
  "list_jfr_recordings",
  {
    description: "Lists active and recent JFR recordings for a Java process (jcmd JFR.check). Returns recording id, duration, state (running/stopped), and filename. Use before stop_profiling to get the correct recordingId.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await listJfrRecordings(args) }],
  })
);

server.registerTool(
  "analyze_threads",
  {
    description:
      "Thread dump (jstack -l). Default: plain text. Set structured=true for JSON lock-wait chains (live snapshot). Historical contention: profile_jfr_locks. Deadlock cycle: check_deadlock.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(10)
        .describe("Maximum number of threads to include in the output. Default: 10. Increase for applications with many threads."),
      structured: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return structured JSON with lockWaitChains instead of plain-text dump. Default: false."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await analyzeThreads(args) }],
  })
);

server.registerTool(
  "heap_histogram",
  {
    description:
      "Static class histogram (jcmd GC.class_histogram). For live growth over time use heap_live_histogram_diff instead.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(20)
        .describe("Maximum number of top classes to return. Default: 20."),
      all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include unreachable objects. Triggers full GC and may cause application pause."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await heapHistogram(args) }],
  })
);

server.registerTool(
  "heap_live_histogram_diff",
  {
    description:
      "Two GC.class_histogram snapshots spaced by intervalSeconds; returns classes whose instance count grew most. Use first in memory-leak workflow; then profile_memory and heap_dump (MAT path-to-GC-roots). Each snapshot walks the heap and may pause the app.",
    inputSchema: z.object({
      pid: z.number().int().positive().describe("Process ID from list_java_processes."),
      intervalSeconds: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .default(5)
        .describe("Seconds between baseline and snapshot histograms. Default: 5."),
      topN: z.number().int().min(1).max(200).optional().default(20),
      all: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include unreachable objects (-all). Triggers full GC and may pause the app."),
      minInstanceDelta: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Ignore classes with instance growth below this threshold."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await heapLiveHistogramDiff(args) }],
  })
);

server.registerTool(
  "heap_dump",
  {
    description:
      "Creates .hprof for Eclipse MAT / VisualVM. After heap_live_histogram_diff picks a growing class, use MAT Path to GC Roots (exclude weak/soft). Saved to recordings/heap_dump.hprof. Warning: large file.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await heapDump(args) }],
  })
);

server.registerTool(
  "heap_info",
  {
    description: "Brief heap usage summary: capacities, used, committed regions. Quick snapshot without full dump.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await heapInfo(args) }],
  })
);

server.registerTool(
  "vm_info",
  {
    description: "JVM information: uptime, version, and flags. Useful for environment verification.",
    inputSchema: z.object({
      pid: z
        .number()
        .int()
        .positive()
        .describe("Process ID of the Java application. Get this from list_java_processes."),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await vmInfo(args) }],
  })
);

server.registerTool(
  "trace_method",
  {
    description: "Builds a call tree for a specific method from a .jfr file. Filters ExecutionSample events to find stack traces containing the given class and method, then aggregates call paths. Use when you want to see who calls a particular method and from where. Limitation: JFR sampling (~10 ms) may miss very fast methods.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr file. Shortcuts: 'new_profile' (current, default) or 'old_profile' (previous). Or full path e.g. recordings/new_profile.jfr."),
      className: z
        .string()
        .describe("Fully qualified class name (e.g. com.example.MyService) or a substring to match. Used to filter stack frames."),
      methodName: z
        .string()
        .describe("Method name to search for (e.g. processRequest). Matches the method in the stack trace."),
      events: z
        .array(z.string())
        .optional()
        .describe("Optional list of JFR event types to parse. Default: jdk.ExecutionSample. Advanced users can specify other event types."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of call paths (branches) to return in the call tree. Default: 10."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await traceMethod(args, context) }],
  })
);

server.registerTool(
  "parse_jfr_summary",
  {
    description: "Parses a .jfr file and returns a structured summary: top methods by CPU samples, GC statistics, thread allocation stats, and anomaly hints (e.g. high GC count). Use for a quick high-level overview of the recording before diving into specific profiles.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr file. Shortcuts: 'new_profile' (current, default) or 'old_profile' (previous). Or full path e.g. recordings/new_profile.jfr."),
      events: z
        .array(z.string())
        .optional()
        .describe("Optional list of JFR event types to include. Default: jdk.ExecutionSample, jdk.GarbageCollection, jdk.JavaThreadStatistics, jdk.ThreadAllocationStatistics."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of top methods to include in the summary. Default: 10."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await parseJfrSummary(args, context) }],
  })
);

server.registerTool(
  "profile_memory",
  {
    description:
      "JFR memory profile: top allocators by bytes/count, allocation stacks, OldObjectSample by class (allocation site, not GC roots). Pair with heap_live_histogram_diff, gc_efficiency, heap_dump+MAT. Requires profile preset recording.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr file. Shortcuts: 'new_profile' (current, default) or 'old_profile' (previous). Or full path e.g. recordings/new_profile.jfr."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of top allocators to return. Default: 10."),
      sortBy: z
        .enum(["bytes", "count"])
        .optional()
        .default("bytes")
        .describe("Primary ranking for topAllocators. Default: bytes."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileMemory(args, context) }],
  })
);

server.registerTool(
  "gc_efficiency",
  {
    description:
      "GC efficiency from .jfr: pause time vs freed bytes per collector/cause. Use after stop_profiling; complements profile_memory and heap_info. Not a general JFR summary (see parse_jfr_summary).",
    inputSchema: z.object({
      filepath: z.string().optional().default("new_profile"),
      topN: z.number().int().min(1).max(100).optional().default(10),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await gcEfficiency(args, context) }],
  })
);

server.registerTool(
  "profile_time",
  {
    description: "CPU time (bottleneck) profile from a .jfr file. Uses bottom-up aggregation: each method is counted in every sample where it appears in the stack, including time spent in callees. Returns methods consuming the most CPU time. Use when the goal is to find performance bottlenecks and slow code paths.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr file. Shortcuts: 'new_profile' (current, default) or 'old_profile' (previous). Or full path e.g. recordings/new_profile.jfr."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of top methods by CPU time to return. Default: 10."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileTime(args, context) }],
  })
);

server.registerTool(
  "profile_frequency",
  {
    description: "Call frequency profile from a .jfr file. Counts methods that appear at the leaf (top) of the stack in ExecutionSample events — i.e. methods that were actively executing when sampled. Returns the most frequently sampled methods (exclusive, not cumulative). Use when looking for hot spots or the most often executed code paths.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr file. Shortcuts: 'new_profile' (current, default) or 'old_profile' (previous). Or full path e.g. recordings/new_profile.jfr."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Maximum number of top methods by call frequency to return. Default: 10."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileFrequency(args, context) }],
  })
);

server.registerTool(
  "profile_jfr_network",
  {
    description:
      "Summarize JDK socket I/O from a .jfr (jdk.SocketRead, jdk.SocketWrite): event counts, total bytes read/written where available, top endpoints (host:port / address), and cumulative stack hotspots. Recording must include those events (custom .jfc or preset that enables them). If emptyEvents, use start_profiling settingsFile.",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr. Shortcuts: new_profile, old_profile, or absolute path."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Top N endpoints and methods."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileJfrNetwork(args, context) }],
  })
);

server.registerTool(
  "profile_jfr_file_io",
  {
    description:
      "Summarize file read/write events (jdk.FileRead, jdk.FileWrite): counts, bytes, top paths, stack hotspots. Events must exist in recording; configure via start_profiling preset or settingsFile (.jfc).",
    inputSchema: z.object({
      filepath: z
        .string()
        .optional()
        .default("new_profile")
        .describe("Path to .jfr. Shortcuts: new_profile, old_profile."),
      topN: z.number().int().min(1).max(100).optional().default(10).describe("Top N paths/methods."),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileJfrFileIo(args, context) }],
  })
);

server.registerTool(
  "profile_jfr_locks",
  {
    description:
      "Lock contention from JFR: synchronized monitors (JavaMonitorBlocked) and j.u.c parking (ThreadPark). Live wait chains: analyze_threads structured=true. Deadlocks: check_deadlock. Enable events via custom .jfc if missing.",
    inputSchema: z.object({
      filepath: z.string().optional().default("new_profile"),
      topN: z.number().int().min(1).max(100).optional().default(10),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileJfrLocks(args, context) }],
  })
);

server.registerTool(
  "profile_jfr_native",
  {
    description:
      "CPU-style cumulative hotspots from jdk.NativeMethodSample stacks. Recording must enable NativeMethodSample (often requires custom .jfc).",
    inputSchema: z.object({
      filepath: z.string().optional().default("new_profile"),
      topN: z.number().int().min(1).max(100).optional().default(10),
    }),
  },
  async (args, context) => ({
    content: [{ type: "text", text: await profileJfrNative(args, context) }],
  })
);

server.registerTool(
  "native_memory_summary",
  {
    description:
      "jcmd VM.native_memory summary=true. Requires JVM started with -XX:NativeMemoryTracking=summary or detail; otherwise explains how to enable.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await nativeMemorySummary(args) }],
  })
);

server.registerTool(
  "gc_class_stats",
  {
    description:
      "jcmd GC.class_stats (class loader / metaspace style stats where supported—often JDK 21+). On older JDK returns error hint; use heap_info or heap_histogram instead.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await gcClassStats(args) }],
  })
);

server.registerTool(
  "gc_finalizer_info",
  {
    description: "jcmd GC.finalizer_info — finalizer queue diagnostics for the live process.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await gcFinalizerInfo(args) }],
  })
);

server.registerTool(
  "compiler_codecache",
  {
    description: "jcmd Compiler.codecache — code heap usage and related JVM output.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await compilerCodecache(args) }],
  })
);

server.registerTool(
  "compiler_queue",
  {
    description: "jcmd Compiler.queue — methods queued for JIT compilation.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
    }),
  },
  async (args) => ({
    content: [{ type: "text", text: await compilerQueue(args) }],
  })
);

server.registerTool(
  "profile_per_thread",
  {
    description:
      "Per-thread call tree from a .jfr file, with threads auto-grouped (edt / idePool / dispatcher / fjPool / indexing / telemetry / gc / other). Each group returns top frames both inclusive (anywhere in stack) and leaf (self time). High-fidelity mode uses the JetBrains IDE's already-parsed Profiler model via the JetDesk IDE bridge (requires mcp-steroid + a running IDE with the Profiler Ultimate plugin). Best for editor stutter / freeze triage where a single thread or thread family dominates. Response includes a top-level `metric` field (wallClockMs for wallClockCpu/wallClockTotal, bytes for memoryAllocations, samples for cpu) — the `value` / `totalValue` / `selfValue` numbers are in that unit. For memoryAllocations, leaf frames may be the ALLOCATED TYPE (e.g. 'java.awt.Component[]') rather than a code frame — the IDE injects the allocated class as a fake top frame so you see what was allocated, not where.",
    inputSchema: profilePerThreadSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profilePerThread(args) }],
  })
);

server.registerTool(
  "profile_call_tree",
  {
    description:
      "Multi-mode call-tree extraction from a .jfr file. Modes: 'hierarchical' (top-N tree across matched threads, optionally rooted at a method), 'flat' (aggregated list with self/total values, sortable), 'callees' (children subtree of a method), 'backtrace' (callers tree for a method, walks parent chains). Bridge-only: requires a JetBrains IDE reachable via mcp-steroid with the Profiler Ultimate plugin. Use this for deep call-graph navigation (drill into hot subtrees, find callers of a slow method, get exclusive-time leaf hotspots) — the flat tools (profile_time, profile_frequency) only return whole-stack aggregations. Response includes a top-level `metric` field (wallClockMs / bytes / samples) — the `value` / `totalValue` / `selfValue` numbers are in that unit. For memoryAllocations, frames may include the ALLOCATED TYPE injected by the IDE as a fake frame (e.g. 'java.awt.Component[]'). If the requested `treeId` is not present in the snapshot, returns `{ error, availableTrees }` listing what IS available — use profile_describe_snapshot first to learn what's recorded.",
    inputSchema: profileCallTreeSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileCallTree(args) }],
  })
);

server.registerTool(
  "profile_edt_hotspot",
  {
    description:
      "EDT (AWT-EventQueue) hot path + leaf hotspots from a .jfr file. Returns a hierarchical descent following the hottest child at each step (so you see what the EDT was actually doing during a freeze) plus the top exclusive-time leaf frames. Bridge-only: requires a JetBrains IDE reachable via mcp-steroid. First-look tool for freeze / editor-stutter triage — for richer per-thread breakdown use profile_per_thread; to drill into a method use profile_call_tree mode=callees. Response includes a top-level `metric` field (wallClockMs / bytes / samples). Returns `{ error, availableTrees }` if the requested treeId isn't in the snapshot.",
    inputSchema: profileEdtHotspotSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileEdtHotspot(args) }],
  })
);

server.registerTool(
  "profile_subsystem_scan",
  {
    description:
      "Auto-grouped subsystem breakdown of a .jfr file. Subsystems are derived from each frame's package prefix at `packageDepth` segments (e.g. 'com.intellij.spring', 'org.jetbrains.kotlin.idea') — no hardcoded keyword list. Stdlib/runtime excluded. Use to spot a dominant subsystem (Spring AOP processing 27%, an obscure plugin namespace at 40%) without prior hypotheses. Inclusive counting — every distinct subsystem in a stack is counted once per event. Bridge-only: requires a JetBrains IDE reachable via mcp-steroid. Response includes a top-level `metric` field (wallClockMs / bytes / samples); `inclusiveValue` is in that unit. Returns `{ error, availableTrees }` if the requested treeId isn't in the snapshot.",
    inputSchema: profileSubsystemScanSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileSubsystemScan(args) }],
  })
);

server.registerTool(
  "profile_list_threads",
  {
    description:
      "Fast thread inventory for an open snapshot. Returns a group summary (edt / idePool / dispatcher / fjPool / indexing / telemetry / gc / other — count + total value + %) and the top-N threads by value with each thread's hottest-leaf frame as a one-line summary. Cheap first-look tool to identify which threads are worth drilling into with profile_per_thread or profile_call_tree. Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.",
    inputSchema: profileListThreadsSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileListThreads(args) }],
  })
);

server.registerTool(
  "profile_describe_snapshot",
  {
    description:
      "Discovery tool: returns which call trees the snapshot contains (wallClockCpu / wallClockTotal / cpu / memoryAllocations), each tree's metric (wallClockMs / bytes / samples), thread count per tree, and total value. Cheap first call to learn what the snapshot can answer before invoking deeper tools — a JFR captured without memory events will not list memoryAllocations, and any tool call with that treeId will then return a clean error. Bridge-only: requires a JetBrains IDE reachable via mcp-steroid.",
    inputSchema: profileDescribeSnapshotSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileDescribeSnapshot(args) }],
  })
);

server.registerTool(
  "profile_heap_health",
  {
    description:
      "Heap health summary from JFR GC events: xmxMb + source, GC cadence + count, post-GC heap usage trend, latest after-GC % of xmx, CPU load avg/max, and a one-word assessment (Healthy / Moderate / High / Critical). Use to answer 'is the heap under pressure?'. Reads JFR events directly via JMC (no Profiler tool-window dependency) — faster than the call-tree tools. Bridge-only.",
    inputSchema: profileHeapHealthSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileHeapHealth(args) }],
  })
);

server.registerTool(
  "profile_env",
  {
    description:
      "Snapshot env metadata: OS + display server, CPU cores, JVM info (version / vendor / JBR flag), JVM arguments (-Xmx etc), recording metadata (start time / duration), and async-profiler settings (sampling interval, wall-clock mode). Use when context about the captured environment matters — display server detection, JBR vs OpenJDK, configured heap. Reads JFR events directly via JMC. Bridge-only.",
    inputSchema: profileEnvSchema,
  },
  async (args) => ({
    content: [{ type: "text", text: await profileEnv(args) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
