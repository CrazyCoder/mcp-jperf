import { z } from "zod";
import { existsSync } from "node:fs";
import { runJfr, streamJfrJsonEvents } from "../utils/jdk.js";
import { resolveProfilePath } from "../utils/paths.js";
import { getEventType, getStackTrace, getMethodKey, getEventValues, toNumberLoose } from "../utils/jfr-json.js";
import { formatError } from "../utils/errors.js";

export const parseJfrSummarySchema = z.object({
  filepath: z.string(),
  events: z.array(z.string()).optional(),
  topN: z.number().int().min(1).max(100).optional().default(10),
});

export type ParseJfrSummaryInput = z.infer<typeof parseJfrSummarySchema>;

export async function parseJfrSummary(input: ParseJfrSummaryInput, context?: unknown): Promise<string> {
  const { topN } = input;
  const filepath = resolveProfilePath(input.filepath);

  if (!existsSync(filepath)) {
    return formatError(`File not found: ${filepath}`, "FILE_NOT_FOUND", "Create a recording with start_profiling and stop_profiling.");
  }

  const events = input.events ?? [
    "jdk.ExecutionSample",
    "jdk.GarbageCollection",
    "jdk.JavaThreadStatistics",
    "jdk.ThreadAllocationStatistics",
    // Not all recordings carry jdk.GarbageCollection — the JetBrains Profiler
    // preset omits it — but the heap-summary events are emitted per collection
    // and carry a gcId, so distinct gcIds recover the count. Without this a
    // recording with thousands of collections reports gcEvents: 0.
    "jdk.G1HeapSummary",
    "jdk.GCHeapSummary",
  ];
  const eventsArg = events.join(",");

  const summaryOut = await runJfr(["summary", filepath]);

  const methodCount: Map<string, number> = new Map();
  let gcCount = 0;
  const gcIds = new Set<number>();
  const anomalies: string[] = [];

  try {
    const mcpReq = (context as { mcpReq?: { _meta?: { progressToken?: string | number }; notify?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void> } } | undefined)?.mcpReq;
    await streamJfrJsonEvents(
      ["print", "--json", "--events", eventsArg, filepath],
      (ev) => {
        const typ = getEventType(ev);
        if (typ === "jdk.GarbageCollection") gcCount++;
        if (typ === "jdk.G1HeapSummary" || typ === "jdk.GCHeapSummary") {
          const id = toNumberLoose(getEventValues(ev).gcId);
          if (id !== undefined) gcIds.add(id);
        }

        if (typ === "jdk.ExecutionSample") {
          const frames = getStackTrace(ev)?.frames ?? [];
          for (const f of frames) {
            const key = getMethodKey(f);
            if (key) methodCount.set(key, (methodCount.get(key) ?? 0) + 1);
          }
        }
      },
      (processed) => {
        const progressToken = mcpReq?._meta?.progressToken;
        if (progressToken === undefined || mcpReq?.notify === undefined) return;
        void mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: Math.max(processed, 1), message: `Parsed ${processed} summary events` },
        });
      }
    );

  } catch {
    // continue with summary only
  }

  const topMethods = [...methodCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([m, c]) => ({ method: m, samples: c }));

  const result = {
    summary: summaryOut.trim(),
    topMethods,
    gcStats: {
      gcEvents: gcCount > 0 ? gcCount : gcIds.size,
      // "GarbageCollection" = direct event count; "heapSummaryGcIds" = distinct
      // gcIds recovered from heap-summary events when the direct event is absent.
      source: gcCount > 0 ? "jdk.GarbageCollection" : gcIds.size > 0 ? "heapSummaryGcIds" : "none",
    },
    anomalies: anomalies.length ? anomalies : undefined,
  };

  return JSON.stringify(result, null, 2);
}
