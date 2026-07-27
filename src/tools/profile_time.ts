import { z } from "zod";
import { existsSync } from "node:fs";
import { streamJfrJsonEvents } from "../utils/jdk.js";
import { resolveProfilePath } from "../utils/paths.js";
import { getStackTrace, getMethodKey, isWaitLeaf } from "../utils/jfr-json.js";
import { formatError } from "../utils/errors.js";

export const profileTimeSchema = z.object({
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

export type ProfileTimeInput = z.infer<typeof profileTimeSchema>;

export async function profileTime(input: ProfileTimeInput, context?: unknown): Promise<string> {
  const { topN, excludeWaitLeaves } = input;
  const filepath = resolveProfilePath(input.filepath);

  if (!existsSync(filepath)) {
    return formatError(`File not found: ${filepath}`, "FILE_NOT_FOUND", "Create a recording with start_profiling and stop_profiling.");
  }

  const methodSamples: Map<string, number> = new Map();
  let totalSamples = 0;
  let waitSamples = 0;
  const mcpReq = (context as { mcpReq?: { _meta?: { progressToken?: string | number }; notify?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> } } | undefined)?.mcpReq;

  try {
    await streamJfrJsonEvents(
      ["print", "--json", "--events", "jdk.ExecutionSample", filepath],
      (ev) => {
        const frames = getStackTrace(ev)?.frames ?? [];
        if (frames.length === 0) return;
        totalSamples++;
        // A sample whose leaf is parked contributed no CPU, so the whole
        // sample is dropped rather than just its leaf frame.
        const leafKey = getMethodKey(frames[0]);
        if (leafKey && isWaitLeaf(leafKey)) {
          waitSamples++;
          if (excludeWaitLeaves) return;
        }
        for (const f of frames) {
          const key = getMethodKey(f);
          if (key) methodSamples.set(key, (methodSamples.get(key) ?? 0) + 1);
        }
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

  const top = [...methodSamples.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([method, samples]) => ({ method, samples, note: "cumulative CPU time (incl. callees)" }));

  return JSON.stringify(
    {
      profile: "time",
      totalSamples,
      waitSamples,
      countedSamples: excludeWaitLeaves ? totalSamples - waitSamples : totalSamples,
      excludeWaitLeaves,
      topMethods: top,
    },
    null,
    2,
  );
}
