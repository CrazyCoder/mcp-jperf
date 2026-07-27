import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge, summarizeBridgeError } from "../utils/ide-bridge.js";
import {
  buildPerThreadTrees,
  classifyThreadGroup,
  DEFAULT_WALL_CLOCK_EVENTS,
  runJfrTextSamples,
  selfValueOf,
  type RawSampleEvent,
  type SynthCallNode,
} from "../utils/jfr-cli-aggregator.js";

export const profilePerThreadSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to query: wallClockCpu (running threads), wallClockTotal (running+sleeping), cpu (jdk.ExecutionSample only, no wall-clock merge), memoryAllocations."),
  threadFilter: z
    .string()
    .optional()
    .default("*")
    .describe("Glob pattern matched against thread names. '*' matches all. Examples: 'AWT-EventQueue*', 'DefaultDispatcher-worker-*'."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Top frames per group, both inclusive and leaf. Default 10."),
});

export type ProfilePerThreadInput = z.infer<typeof profilePerThreadSchema>;

/**
 * Per-thread call tree extraction. Threads are auto-grouped into EDT / idePool /
 * dispatcher / fjPool / indexing / telemetry / gc / other; each group reports
 * its hot inclusive frames (anywhere in stack) and leaf frames (self time).
 *
 * Bridge mode (IDE reachable): delegates to extract-per-thread.kts, which
 * reads the IDE's already-parsed call tree (state-aware, wall-clock-interval-
 * scaled, JBR-aware). Metric = wallClockMs|bytes|samples.
 *
 * CLI fallback: synthesizes per-thread trees from streamed JFR samples and
 * aggregates inclusive + leaf frame counts per group. Metric = samples; numbers
 * differ from bridge mode but group ranking is similar. `treeId` is ignored
 * in CLI mode.
 */
export async function profilePerThread(input: ProfilePerThreadInput): Promise<string> {
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
      const { open, result } = await ide.runner.runSnapshotScript(
        ide.bridge,
        "extract-per-thread.kts",
        filepath,
        {
          topN: String(input.topN),
          threadFilter: input.threadFilter,
          treeId: input.treeId,
        },
        { taskId: "javaperf:profile_per_thread", reason: `profile_per_thread on ${filepath}` },
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
      bridgeError = summarizeBridgeError((err as Error).message);
    }
  }

  try {
    const out = await computePerThreadCli(filepath, input.threadFilter, input.topN);
    return JSON.stringify({ source: "jfr-cli", ...(bridgeError ? { degradedFrom: "ide-bridge", bridgeError } : {}), snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

function globToRegex(pattern: string): RegExp | null {
  if (pattern === "*") return null;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function computePerThreadCli(
  filepath: string,
  threadFilter: string,
  topN: number,
): Promise<Record<string, unknown>> {
  const events: RawSampleEvent[] = [];
  await runJfrTextSamples(filepath, DEFAULT_WALL_CLOCK_EVENTS, 64, (ev) => {
    events.push(ev);
  });
  const trees = buildPerThreadTrees(events);

  const filterRe = globToRegex(threadFilter);
  const groupLeaf = new Map<string, Map<string, number>>();
  const groupInclusive = new Map<string, Map<string, number>>();
  const threadCountByGroup = new Map<string, number>();
  const groupSamples = new Map<string, number>();
  const matchedThreads: string[] = [];

  for (const [name, root] of trees) {
    if (filterRe && !filterRe.test(name)) continue;
    matchedThreads.push(name);
    const group = classifyThreadGroup(name);
    threadCountByGroup.set(group, (threadCountByGroup.get(group) ?? 0) + 1);
    groupSamples.set(group, (groupSamples.get(group) ?? 0) + root.value);

    let leaf = groupLeaf.get(group);
    if (!leaf) {
      leaf = new Map();
      groupLeaf.set(group, leaf);
    }
    let incl = groupInclusive.get(group);
    if (!incl) {
      incl = new Map();
      groupInclusive.set(group, incl);
    }

    // Walk every node under the thread root. Inclusive = node.value; leaf = selfValueOf(node).
    const stack: SynthCallNode[] = [...root.children.values()];
    while (stack.length) {
      const n = stack.pop()!;
      if (!n.frame) continue;
      incl.set(n.frame, (incl.get(n.frame) ?? 0) + n.value);
      const s = selfValueOf(n);
      if (s > 0) leaf.set(n.frame, (leaf.get(n.frame) ?? 0) + s);
      for (const c of n.children.values()) stack.push(c);
    }
  }

  const orderedGroups = [...groupSamples.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g);
  const groupsOut: Record<string, unknown> = {};
  for (const g of orderedGroups) {
    const total = groupSamples.get(g) ?? 0;
    const inclusive = [...(groupInclusive.get(g) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([method, value]) => ({ method, value }));
    const leaf = [...(groupLeaf.get(g) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([method, value]) => ({ method, value }));
    groupsOut[g] = {
      threadCount: threadCountByGroup.get(g) ?? 0,
      totalValue: total,
      inclusive,
      leaf,
    };
  }

  return {
    treeId: null,
    metric: "samples",
    totalThreadsInSnapshot: trees.size,
    matchedThreadCount: matchedThreads.length,
    matchedThreadSample: matchedThreads.slice(0, 8),
    groupsSortedByValue: orderedGroups,
    groups: groupsOut,
  };
}
