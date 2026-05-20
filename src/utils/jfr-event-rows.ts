/**
 * Read JFR events as JSON rows. Tier-1 tools (heap_health, env) need a small
 * number of jdk.* event types with their attribute maps — this helper reuses
 * the streaming JSON parser in `jdk.ts` and groups events by type.
 *
 * Output shape mirrors what extract-heap-health.kts / extract-env.kts returned
 * from JMC's IItemIterable — `Map<type, Array<attribute-bag>>`. Attribute
 * values are kept in jfr's native JSON form (numbers stay numbers; nested
 * objects like heapSpace remain objects).
 */
import { streamJfrJsonEvents } from "./jdk.js";

export async function readJfrEventRows(
  filepath: string,
  eventTypes: string[],
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const want = new Set(eventTypes);
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const t of eventTypes) out.set(t, []);

  await streamJfrJsonEvents(
    ["print", "--json", "--events", eventTypes.join(","), filepath],
    (ev) => {
      const e = ev as { type?: string; values?: Record<string, unknown> };
      const typ = e?.type;
      if (!typ || !want.has(typ)) return;
      const bag = e.values ?? {};
      out.get(typ)!.push(bag);
    },
  );
  return out;
}

/** First row of a given event type, or null. Convenience for one-shot events like JVMInformation. */
export function firstRow(
  rows: Map<string, Array<Record<string, unknown>>>,
  type: string,
): Record<string, unknown> | null {
  const list = rows.get(type);
  if (!list || list.length === 0) return null;
  return list[0];
}

/** Coerce a raw JSON value to a string. JMC-style attributes can be numbers,
 *  strings, booleans, or composite objects — `toString()` on the JMC side
 *  flattens them all; here we mirror that by JSON-stringifying objects. */
export function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Parse a JMC IQuantity-ish byte string ("1234567 B", "12.5 MiB", "1G") OR
 * accept a plain number (jfr's JSON sometimes returns the raw byte count for
 * size attributes). Returns null when neither shape matches.
 */
export function parseBytes(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && v !== null) {
    // jfr JSON occasionally wraps size attrs as { bits, value, unit, ... }.
    const o = v as { bits?: unknown; value?: unknown; bytes?: unknown };
    const candidate = o.bytes ?? o.bits ?? o.value;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") return parseBytesFromString(candidate);
  }
  if (typeof v === "string") return parseBytesFromString(v);
  return null;
}

function parseBytesFromString(s: string): number | null {
  if (!s) return null;
  const m = /([\d.]+)\s*([KMGT]?i?B?)/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase().replace(/I?B?$/, "");
  const mult = unit === "" ? 1 : unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : unit === "T" ? 1024 ** 4 : 1;
  return Math.round(n * mult);
}

/** Parse a percentage value: number 0..1 or 0..100, or string like "23.4%". */
export function parsePercent(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /([\d.]+)\s*%?/.exec(v);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse a JVM size flag (e.g. -Xmx4g, -Xms512m) out of an args string. Returns bytes. */
export function parseFlagSize(args: string, flag: string): number | null {
  if (!args) return null;
  const re = new RegExp(`${flag}(\\d+)([kKmMgG])?`, "g");
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(args)) !== null) last = m;
  if (!last) return null;
  const n = Number(last[1]);
  if (!Number.isFinite(n)) return null;
  const u = (last[2] ?? "").toLowerCase();
  return u === "k" ? n * 1024 : u === "m" ? n * 1024 ** 2 : u === "g" ? n * 1024 ** 3 : n;
}

/** Parse a JFR timestamp (ISO-ish string with nanos) → epoch milliseconds. */
export function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
