import { z } from "zod";
import { existsSync } from "node:fs";
import { streamJfrJsonEvents } from "../utils/jdk.js";
import { resolveProfilePath } from "../utils/paths.js";
import { getStackTrace, getMethodKey, isWaitLeaf } from "../utils/jfr-json.js";
import { formatError } from "../utils/errors.js";

export const profileFrequencySchema = z.object({
  filepath: z.string(),
  topN: z.number().int().min(1).max(100).optional().default(10),
  excludeWaitLeaves: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Drop samples whose leaf frame is a parked/blocked wait (__psynch_cvwait, Unsafe.park, epoll_wait, ...). " +
      "Wall-clock recordings emit ExecutionSample for sleeping threads too, so the default ranking is dominated " +
      "by waiting rather than CPU. Set true to see where CPU actually went.",
    ),
});

export type ProfileFrequencyInput = z.infer<typeof profileFrequencySchema>;

export async function profileFrequency(input: ProfileFrequencyInput, context?: unknown): Promise<string> {
  const { topN, excludeWaitLeaves } = input;
  const filepath = resolveProfilePath(input.filepath);

  if (!existsSync(filepath)) {
    return formatError(`File not found: ${filepath}`, "FILE_NOT_FOUND", "Create a recording with start_profiling and stop_profiling.");
  }

  const leafCount: Map<string, number> = new Map();
  let totalSamples = 0;
  let waitSamples = 0;
  const mcpReq = (context as { mcpReq?: { _meta?: { progressToken?: string | number }; notify?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> } } | undefined)?.mcpReq;

  try {
    await streamJfrJsonEvents(
      ["print", "--json", "--events", "jdk.ExecutionSample", filepath],
      (ev) => {
        const frames = getStackTrace(ev)?.frames ?? [];
        const leaf = frames[0];
        if (!leaf) return;
        const key = getMethodKey(leaf);
        if (!key) return;
        totalSamples++;
        if (isWaitLeaf(key)) {
          waitSamples++;
          if (excludeWaitLeaves) return;
        }
        leafCount.set(key, (leafCount.get(key) ?? 0) + 1);
      },
      (processed) => {
        const progressToken = mcpReq?._meta?.progressToken;
        if (progressToken === undefined || mcpReq?.notify === undefined) return;
        void mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: Math.max(processed, 1), message: `Parsed ${processed} execution samples` },
        });
      }
    );
  } catch {
    return formatError("Failed to parse JFR ExecutionSample output.", "PARSE_ERROR", "Ensure the .jfr file is valid and was created with settings=profile.");
  }

  const top = [...leafCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([method, samples]) => ({ method, samples, note: "exclusive (leaf frame)" }));

  return JSON.stringify(
    {
      profile: "frequency",
      totalSamples,
      waitSamples,
      // Always reported, so the caller can see how much of the recording was
      // parked even when nothing was filtered out.
      countedSamples: excludeWaitLeaves ? totalSamples - waitSamples : totalSamples,
      excludeWaitLeaves,
      topMethods: top,
    },
    null,
    2,
  );
}
