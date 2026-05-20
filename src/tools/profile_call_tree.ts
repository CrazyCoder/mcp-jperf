import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";
import {
  buildPerThreadTrees,
  DEFAULT_WALL_CLOCK_EVENTS,
  runJfrTextSamples,
  selfValueOf,
  type RawSampleEvent,
  type SynthCallNode,
} from "../utils/jfr-cli-aggregator.js";

export const profileCallTreeSchema = z.object({
  filepath: z
    .string()
    .optional()
    .default("new_profile")
    .describe("Path to .jfr. Shortcuts: new_profile (current, default), old_profile (previous), or full path."),
  treeId: z
    .enum(["wallClockCpu", "wallClockTotal", "cpu", "memoryAllocations"])
    .optional()
    .default("wallClockCpu")
    .describe("Which call tree to query: wallClockCpu (running threads), wallClockTotal (running+sleeping), cpu (ExecutionSample only), memoryAllocations."),
  mode: z
    .enum(["hierarchical", "flat", "callees", "backtrace"])
    .optional()
    .default("hierarchical")
    .describe(
      "Analysis mode: 'hierarchical' top-N tree across matched threads (optionally rooted at `root`); " +
      "'flat' aggregated method list with self/total samples (sortable); " +
      "'callees' children subtree of `root`; " +
      "'backtrace' callers tree for `root` (walks parent chains). " +
      "Modes 'callees' and 'backtrace' require `root`.",
    ),
  root: z
    .string()
    .optional()
    .default("")
    .describe(
      "Case-insensitive substring matched against the rendered frame string " +
      "(e.g. 'JComponent.paint', 'HashMap.getNode', 'spring.aop'). Required for " +
      "'callees' and 'backtrace'. Optional for 'hierarchical' (drills into the matched subtree).",
    ),
  threadFilter: z
    .string()
    .optional()
    .default("*")
    .describe("Glob pattern matched against thread names. '*' matches all. Examples: 'AWT-EventQueue*', 'DefaultDispatcher-worker-*'."),
  topN: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe("Top entries per tree level (hierarchical/callees/backtrace) or total rows (flat). Default 10."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(3)
    .describe("Tree depth cap for hierarchical/callees/backtrace modes. Default 3."),
  minPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .default(0)
    .describe("Suppress nodes whose samples are below this percentage of the matched threads' grand total. Default 0 (no filter)."),
  sortBy: z
    .enum(["total", "self"])
    .optional()
    .default("total")
    .describe("Flat-mode sort key: 'total' (cumulative samples) or 'self' (exclusive samples). Ignored for tree modes."),
});

export type ProfileCallTreeInput = z.infer<typeof profileCallTreeSchema>;

/**
 * Multi-mode call-tree extraction.
 *
 * Bridge mode (IDE reachable): delegates to extract-call-tree.kts which walks
 * the IDE's already-parsed Profiler model. All four modes supported.
 *
 * CLI fallback: only `flat` mode is available — synthesizes per-thread trees
 * from streamed samples and aggregates total/self per method. Tree-shaped
 * modes (hierarchical/callees/backtrace) still require the IDE bridge.
 *
 * In `flat` mode, `pctOfTotal` may exceed 100% for recursive methods — each
 * tree occurrence contributes (matches IDE "Method List" semantic). `pctSelf`
 * is bounded since self-time is exclusive.
 */
export async function profileCallTree(input: ProfileCallTreeInput): Promise<string> {
  const filepath = resolveProfilePath(input.filepath);
  if (!existsSync(filepath)) {
    return formatError(
      `File not found: ${filepath}`,
      "FILE_NOT_FOUND",
      "Create a recording with start_profiling/stop_profiling, or pass an absolute .jfr path.",
    );
  }

  if ((input.mode === "callees" || input.mode === "backtrace") && !input.root) {
    return formatError(
      `Mode '${input.mode}' requires the 'root' parameter (substring matched against frame strings).`,
      "MISSING_ROOT",
      "Pass `root: 'YourClass.yourMethod'` to focus on a method. Use mode='hierarchical' for a tree-wide view.",
    );
  }

  const ide = await getIdeBridge();
  if (ide) {
    try {
      const { open, result } = await ide.runner.runSnapshotScript(
        ide.bridge,
        "extract-call-tree.kts",
        filepath,
        {
          treeId: input.treeId,
          mode: input.mode,
          root: input.root,
          threadFilter: input.threadFilter,
          topN: String(input.topN),
          depth: String(input.depth),
          minPct: String(input.minPct),
          sortBy: input.sortBy,
        },
        { taskId: "javaperf:profile_call_tree", reason: `profile_call_tree mode=${input.mode} on ${filepath}` },
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
        "Open the .jfr in the IntelliJ Profiler tool window manually, then retry. Or use the flat-aggregate tools (profile_time, profile_frequency).",
      );
    }
  }

  if (input.mode !== "flat") {
    return formatError(
      `profile_call_tree mode '${input.mode}' requires the JetDesk IDE bridge.`,
      "BRIDGE_REQUIRED",
      "CLI fallback only supports mode='flat'. Use mode='flat' here, or use profile_time / profile_frequency for raw flat aggregation.",
    );
  }

  try {
    const out = await computeFlatCli(filepath, input.threadFilter, input.topN, input.minPct, input.sortBy);
    return JSON.stringify({ source: "jfr-cli", snapshot: { file: filepath }, ...out }, null, 2);
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

async function computeFlatCli(
  filepath: string,
  threadFilter: string,
  topN: number,
  minPct: number,
  sortBy: "total" | "self",
): Promise<Record<string, unknown>> {
  const events: RawSampleEvent[] = [];
  await runJfrTextSamples(filepath, DEFAULT_WALL_CLOCK_EVENTS, 64, (ev) => {
    events.push(ev);
  });
  const trees = buildPerThreadTrees(events);

  const filterRe = globToRegex(threadFilter);
  const matched: Array<[string, SynthCallNode]> = [];
  for (const [name, root] of trees) {
    if (filterRe && !filterRe.test(name)) continue;
    matched.push([name, root]);
  }
  if (matched.length === 0) {
    return {
      treeId: null,
      metric: "samples",
      mode: "flat",
      error: `No threads matched filter: ${threadFilter}`,
      totalThreadsInSnapshot: trees.size,
    };
  }

  const grandTotal = matched.reduce((acc, [, r]) => acc + r.value, 0);
  const minSamples = minPct > 0 ? Math.floor((grandTotal * minPct) / 100) : 0;

  const totalAgg = new Map<string, number>();
  const selfAgg = new Map<string, number>();
  for (const [, root] of matched) {
    const stack: SynthCallNode[] = [...root.children.values()];
    while (stack.length) {
      const n = stack.pop()!;
      if (!n.frame) continue;
      totalAgg.set(n.frame, (totalAgg.get(n.frame) ?? 0) + n.value);
      const s = selfValueOf(n);
      if (s > 0) selfAgg.set(n.frame, (selfAgg.get(n.frame) ?? 0) + s);
      for (const c of n.children.values()) stack.push(c);
    }
  }

  const rows = [...totalAgg.entries()]
    .filter(([, v]) => v >= minSamples)
    .sort((a, b) => {
      const av = sortBy === "self" ? (selfAgg.get(a[0]) ?? 0) : a[1];
      const bv = sortBy === "self" ? (selfAgg.get(b[0]) ?? 0) : b[1];
      return bv - av;
    })
    .slice(0, topN)
    .map(([method, total]) => {
      const self = selfAgg.get(method) ?? 0;
      return {
        method,
        totalValue: total,
        selfValue: self,
        pctOfTotal: grandTotal > 0 ? (total / grandTotal) * 100 : 0,
        pctSelf: grandTotal > 0 ? (self / grandTotal) * 100 : 0,
      };
    });

  return {
    treeId: null,
    metric: "samples",
    mode: "flat",
    sortBy,
    matchedThreadCount: matched.length,
    grandTotalValue: grandTotal,
    uniqueMethods: totalAgg.size,
    methods: rows,
  };
}
