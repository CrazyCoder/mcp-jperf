import { z } from "zod";
import { existsSync } from "node:fs";
import { resolveProfilePath } from "../utils/paths.js";
import { formatError } from "../utils/errors.js";
import { getIdeBridge } from "../utils/ide-bridge.js";

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
 * Multi-mode call-tree extraction. Bridge-only (requires a JetBrains IDE with
 * the Profiler Ultimate plugin reachable via mcp-steroid). Delegates to
 * extract-call-tree.kts which walks the IDE's already-parsed Profiler model.
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
  if (!ide) {
    return formatError(
      "profile_call_tree requires the JetDesk IDE bridge.",
      "BRIDGE_REQUIRED",
      "This tool needs a running JetBrains IDE reachable via mcp-steroid. For flat aggregation without an IDE, use profile_time (cumulative) or profile_frequency (leaf).",
    );
  }

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
