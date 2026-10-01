import { z } from 'zod';

/** WebMCP is page-owned data, carried through a bounded, stable Reticle tool surface. */
export const WebMcpStatus = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  UNSUPPORTED: 'unsupported',
  DENIED: 'denied',
} as const;
export const WebMcpApi = { DOCUMENT: 'document', NAVIGATOR: 'navigator' } as const;
export const WebMcpEncoding = { OBJECT: 'object', JSON: 'json' } as const;
export const WebMcpEvent = { CHANGE: 'toolchange' } as const;
export const WebMcpLimits = {
  TOOLS: 500,
  PAGE: 20,
  MAX_PAGE: 50,
  TEXT: 512,
  JSON: 16_000,
  NODES: 2_000,
  DEPTH: 12,
  TIMEOUT_MS: 5_000,
  MAX_TIMEOUT_MS: 8_000,
  VALIDATION_MS: 2_000,
  BRIDGE_GRACE_MS: 250,
} as const;

const selection = {
  toolId: z.string().min(1).max(256).optional(),
  tool: z.string().min(1).max(WebMcpLimits.TEXT).optional(),
  fromOrigins: z.array(z.string().url().max(2048)).max(10).optional(),
};
export const WebMcpDiscoverySchema = z.object({
  ...selection,
  offset: z.number().int().min(0).max(WebMcpLimits.TOOLS).default(0),
  limit: z.number().int().min(1).max(WebMcpLimits.MAX_PAGE).default(WebMcpLimits.PAGE),
});
export const WebMcpArgsSchema = z
  .object({
    ...selection,
    params: z.record(z.unknown()).default({}),
    confirmDangerous: z.boolean().default(false),
    inputEncoding: z.nativeEnum(WebMcpEncoding).default(WebMcpEncoding.OBJECT),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(WebMcpLimits.MAX_TIMEOUT_MS)
      .default(WebMcpLimits.TIMEOUT_MS),
  })
  .refine((v) => (v.toolId !== undefined) !== (v.tool !== undefined), {
    message: 'WebMCP requires exactly one of toolId or tool',
  });
export const WebMcpToolSchema = z.object({
  toolId: z.string(),
  name: z.string(),
  description: z.string(),
  descriptionTruncated: z.boolean().optional(),
  origin: z.string(),
  frameId: z.number().int(),
  revision: z.number().int(),
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    consequentialHint: z.boolean().optional(),
    untrustedContentHint: z.boolean().optional(),
  }),
  // A string keeps transport key redaction from destroying schema properties such as "password".
  inputSchemaJson: z.string().optional(),
});
export const WebMcpCatalogSchema = z.object({
  status: z.nativeEnum(WebMcpStatus),
  api: z.nativeEnum(WebMcpApi).optional(),
  secureContext: z.boolean(),
  total: z.number().int(),
  tools: z.array(WebMcpToolSchema),
  nextOffset: z.number().int().optional(),
  reason: z.string().optional(),
});
export type WebMcpArgs = z.infer<typeof WebMcpArgsSchema>;
export type WebMcpTool = z.infer<typeof WebMcpToolSchema>;
export type WebMcpCatalog = z.infer<typeof WebMcpCatalogSchema>;

/** Reject lossy/non-JSON inputs rather than silently changing what an application receives. */
export function webMcpJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  function check(v: unknown, depth: number): void {
    if (++nodes > WebMcpLimits.NODES || depth > WebMcpLimits.DEPTH) {
      throw new Error('WebMCP JSON exceeds the depth or node limit');
    }
    if (null === v || 'string' === typeof v || 'boolean' === typeof v) return;
    if ('number' === typeof v && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) throw new Error('WebMCP requires acyclic JSON data');
    seen.add(v);
    if (Array.isArray(v)) {
      for (const child of v) check(child, depth + 1);
    } else {
      if (Object.prototype.toString.call(v) !== '[object Object]') {
        throw new Error('WebMCP requires plain JSON objects');
      }
      for (const child of Object.values(v)) check(child, depth + 1);
    }
    seen.delete(v);
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (json.length > WebMcpLimits.JSON) throw new Error('WebMCP JSON exceeds the size limit');
  return json;
}
