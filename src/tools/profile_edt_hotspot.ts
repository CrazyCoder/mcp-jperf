import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge, summarizeBridgeError } from "../utils/ide-bridge.js";
import {
  buildPerThreadTrees,
  DEFAULT_WALL_CLOCK_EVENTS,
  runJfrTextSamples,
  selfValueOf,
  type RawSampleEvent,
  type SynthCallNode,
} from "../utils/jfr-cli-aggregator.js";

export const profileEdtHotspotSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to query. For freeze triage start with wallClockTotal (includes blocked time); for hot-CPU paths use wallClockCpu."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("Number of leaf (self-time) hot frames to return across all EDT threads. Default 20."),
});

export type ProfileEdtHotspotInput = z.infer<typeof profileEdtHotspotSchema>;

/**
 * EDT-focused hot path + leaf hotspots. Returns:
 *   - hotPath: hierarchical descent from the EDT root following the hottest
 *     child at each step until a single branch no longer dominates (<30% of
 *     parent). Best for "what is the EDT actually doing during this freeze?"
 *   - leaves: top-N self-time frames across all EDT threads (exclusive hot spots).
 *
 * Bridge mode (IDE reachable): uses the IDE's already-parsed call tree.
 * Metric = wallClockMs|bytes|samples.
 * CLI fallback: synthesizes EDT-thread trees from streamed samples and walks
 * the hottest-child chain the same way. Metric = samples.
 */
export async function profileEdtHotspot(input: ProfileEdtHotspotInput): Promise<string> {
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
        "extract-edt-hotspots.kts",
        filepath,
        {
          topN: String(input.topN),
          treeId: input.treeId,
        },
        { taskId: "javaperf:profile_edt_hotspot", reason: `profile_edt_hotspot on ${filepath}` },
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
    const out = await computeEdtCli(filepath, input.topN);
    return JSON.stringify({ source: "jfr-cli", ...(bridgeError ? { degradedFrom: "ide-bridge", bridgeError } : {}), snapshot: { file: filepath }, ...out }, null, 2);
  } catch (err) {
    return formatError(
      `jfr CLI failed: ${(err as Error).message}`,
      "JFR_CLI_ERROR",
      "Check that JAVA_HOME points to a JDK 9+ with bin/jfr.",
    );
  }
}

async function computeEdtCli(filepath: string, topN: number): Promise<Record<string, unknown>> {
  const events: RawSampleEvent[] = [];
  await runJfrTextSamples(filepath, DEFAULT_WALL_CLOCK_EVENTS, 64, (ev) => {
    events.push(ev);
  });
  const trees = buildPerThreadTrees(events);
  const edtEntries: Array<[string, SynthCallNode]> = [];
  for (const [name, root] of trees) {
    if (name.startsWith("AWT-EventQueue")) edtEntries.push([name, root]);
  }
  if (edtEntries.length === 0) {
    return {
      treeId: null,
      metric: "samples",
      error: "No AWT-EventQueue threads in snapshot",
      threadsInSnapshot: trees.size,
    };
  }

  const edtThreadNames = edtEntries.map(([n]) => n);
  const totalEdtSamples = edtEntries.reduce((acc, [, r]) => acc + r.value, 0);

  // Hierarchical hot path from the first EDT root: descend by hottest child
  // until its share drops below 30% of parent.
  const firstRoot = edtEntries[0][1];
  const hotPath: Array<Record<string, unknown>> = [];
  {
    let node: SynthCallNode = firstRoot;
    let depth = 0;
    while (depth < 200) {
      let hottest: SynthCallNode | null = null;
      for (const c of node.children.values()) {
        if (!hottest || c.value > hottest.value) hottest = c;
      }
      if (!hottest || !hottest.frame) break;
      const parentValue = node.value;
      const hottestValue = hottest.value;
      hotPath.push({
        depth,
        method: hottest.frame,
        value: hottestValue,
        selfValue: selfValueOf(hottest),
        shareOfParent: parentValue > 0 ? hottestValue / parentValue : 0,
      });
      depth++;
      if (parentValue > 0 && hottestValue / parentValue < 0.3) break;
      node = hottest;
    }
  }

  // Flat leaf top-N across all EDT threads.
  const leaves = new Map<string, number>();
  for (const [, root] of edtEntries) {
    const stack: SynthCallNode[] = [...root.children.values()];
    while (stack.length) {
      const n = stack.pop()!;
      if (!n.frame) continue;
      const s = selfValueOf(n);
      if (s > 0) leaves.set(n.frame, (leaves.get(n.frame) ?? 0) + s);
      for (const c of n.children.values()) stack.push(c);
    }
  }

  const leavesOut = [...leaves.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([method, selfValue]) => ({
      method,
      selfValue,
      pctOfEdt: totalEdtSamples > 0 ? (selfValue / totalEdtSamples) * 100 : 0,
    }));

  return {
    treeId: null,
    metric: "samples",
    edtThreads: edtThreadNames,
    totalEdtValue: totalEdtSamples,
    totalSnapshotThreads: trees.size,
    hotPath,
    leaves: leavesOut,
  };
}
