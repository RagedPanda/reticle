/**
 * Reading what the dashboard answers. Every field is read defensively: an older platform, a proxy
 * or a half-written body must degrade to "nothing confirmed", never to a throw inside the cycle.
 * Kept apart from the cycle (`sync-cycle.ts`), which is the protocol; this is only how its replies
 * are parsed.
 */

export interface StatusResponse {
  knownRunIds?: string[];
  truncated?: boolean;
  stateHashes?: Record<string, string | null>;
  /** What this platform reads. Absent on a platform that predates the handshake. */
  accepts?: unknown;
}

export interface PullResponse {
  triage?: Array<{
    fingerprint: string;
    status: string;
    flowName?: string | null;
    title?: string;
    at: number;
  }>;
  cursor?: string;
  more?: boolean;
}

export const asJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  'object' === typeof v && null !== v;

/** A list of numbers, or undefined when the server did not send a list at all. */
export const numbersIn = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter((n): n is number => 'number' === typeof n) : undefined;

/** A numeric field of an artifact, or undefined when it has none. */
export const numberAt = (v: unknown, field: string): number | undefined => {
  const n = isRecord(v) ? v[field] : undefined;
  return 'number' === typeof n ? n : undefined;
};

/** The name a person knows a flow by, falling back to its position. */
export const flowName = (flow: unknown, index: number): string => {
  const name = isRecord(flow) ? flow['name'] : undefined;
  return 'string' === typeof name && name.length > 0 ? name : `flow #${String(index)}`;
};

/** The server's per-part answer: accepted count and rejection list, each read defensively. */
export function partResult(body: Record<string, unknown>, part: string) {
  const raw = isRecord(body[part]) ? body[part] : {};
  const accepted = 'number' === typeof raw['accepted'] ? raw['accepted'] : 0;
  const rejected = (Array.isArray(raw['rejected']) ? raw['rejected'] : [])
    .filter(isRecord)
    .map((r) => ({
      index: 'number' === typeof r['index'] ? r['index'] : -1,
      reason: 'string' === typeof r['reason'] ? r['reason'] : 'no reason given',
      code: r['code'],
      version: r['version'],
      current: r['current'],
    }));
  return { accepted, rejected };
}
