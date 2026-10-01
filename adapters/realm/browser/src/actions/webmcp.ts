import {
  ActionType,
  ActionWarning,
  DANGEROUS_ACTION_CONFIRM_ARG,
  InputMode,
  newDocumentId,
} from '@reticlehq/core';
import {
  WebMcpApi,
  WebMcpArgsSchema,
  WebMcpDiscoverySchema,
  WebMcpEncoding,
  WebMcpEvent,
  WebMcpLimits,
  WebMcpStatus,
  webMcpJson,
  type WebMcpCatalog,
  type WebMcpTool,
} from '@reticlehq/core/webmcp';
import { requiresDangerousConfirmation } from './danger-context.js';
import { sanitizeWithReport } from '@/security/serialization.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from '@/timers/native/native-timers.js';

interface ModelContext {
  getTools: (options?: { fromOrigins: string[] }) => Promise<unknown>;
  executeTool: (tool: object, input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
  addEventListener?: (name: string, fn: () => void) => void;
  removeEventListener?: (name: string, fn: () => void) => void;
}
interface Entry {
  raw: object;
  metadata: WebMcpTool;
  signature: string;
}
function fields(value: unknown): Record<string, unknown> {
  return value !== null && 'object' === typeof value && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return 'string' === typeof value ? value.slice(0, WebMcpLimits.TEXT) : '';
}
function origins(input: string[] = []): string[] {
  return [
    ...new Set(
      input.map((value) => {
        const url = new URL(value);
        if (url.origin !== value || url.protocol !== 'https:') {
          throw new Error('WebMCP fromOrigins must contain exact HTTPS origins');
        }
        return url.origin;
      }),
    ),
  ].sort();
}
async function bounded<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  abort?: AbortController,
): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = nativeSetTimeout(() => {
          reject(
            new Error(
              'WebMCP timed out; cancellation was requested but effects may have occurred. Do not replay automatically.',
            ),
          );
          abort?.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    nativeClearTimeout(timer);
  }
}

/** Browser-owned handles never cross the bridge. Every returned id belongs to this registry. */
export class WebMcpRegistry {
  readonly #id = newDocumentId(Math.random);
  #next = 0;
  #revision = 0;
  #context: ModelContext | undefined;
  #api: WebMcpCatalog['api'];
  #entries: Entry[] = [];
  #origins: string[] = [];
  #frames = new WeakMap<object, number>();
  #nextFrame = 0;
  readonly #changed = (): void => {
    this.#entries = [];
    this.#revision += 1;
  };

  #host(): ModelContext | undefined {
    const documentApi: unknown = fields(document)['modelContext'];
    const navigatorApi: unknown = fields(navigator)['modelContext'];
    const raw = documentApi ?? navigatorApi;
    this.#api =
      documentApi !== null && documentApi !== undefined
        ? WebMcpApi.DOCUMENT
        : navigatorApi !== null && navigatorApi !== undefined
          ? WebMcpApi.NAVIGATOR
          : undefined;
    if (null === raw || raw === undefined) return undefined;
    const mc = fields(raw);
    if (typeof mc['getTools'] !== 'function' || typeof mc['executeTool'] !== 'function') {
      throw new Error('WebMCP consumer API is unsupported: getTools and executeTool are required');
    }
    return raw as ModelContext;
  }

  async #refresh(
    fromOrigins: string[] | undefined,
    selected: boolean,
    timeoutMs: number = WebMcpLimits.TIMEOUT_MS,
  ): Promise<boolean> {
    const mc = this.#host();
    if (mc !== this.#context) {
      this.#context?.removeEventListener?.(WebMcpEvent.CHANGE, this.#changed);
      this.#changed();
      this.#context = mc;
      mc?.addEventListener?.(WebMcpEvent.CHANGE, this.#changed);
    }
    if (mc === undefined) return false;
    const requested = origins(fromOrigins ?? (selected ? this.#origins : []));
    if (JSON.stringify(requested) !== JSON.stringify(this.#origins)) {
      this.#changed();
      this.#origins = requested;
    }
    const revision = this.#revision;
    const raw = await bounded(() => mc.getTools({ fromOrigins: requested }), timeoutMs);
    if (revision !== this.#revision || mc !== this.#host()) {
      throw new Error('WebMCP registry changed during discovery; discover again');
    }
    if (!Array.isArray(raw) || raw.length > WebMcpLimits.TOOLS) {
      throw new Error('WebMCP registry is malformed or exceeds the tool limit');
    }
    const previous = this.#entries;
    const entries: Entry[] = [];
    for (const value of raw as unknown[]) {
      const tool = fields(value);
      if (
        typeof tool['name'] !== 'string' ||
        0 === tool['name'].length ||
        tool['name'].length > WebMcpLimits.TEXT
      ) {
        throw new Error('WebMCP registry contains an invalid tool name');
      }
      const frame = tool['window'] ?? window;
      if ('object' !== typeof frame || null === frame)
        throw new Error('WebMCP tool has invalid frame identity');
      if (!this.#frames.has(frame)) this.#frames.set(frame, this.#nextFrame++);
      const hints = fields(tool['annotations']);
      const annotations: WebMcpTool['annotations'] = {};
      for (const key of ['readOnlyHint', 'consequentialHint', 'untrustedContentHint'] as const) {
        if ('boolean' === typeof hints[key]) annotations[key] = hints[key];
      }
      const inputSchema = tool['inputSchema'];
      if (
        inputSchema !== undefined &&
        (null === inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema))
      ) {
        throw new Error('WebMCP tool has an invalid input schema');
      }
      const inputSchemaJson = webMcpJson(
        inputSchema === undefined ? { type: 'object' } : inputSchema,
      );
      const metadata = {
        toolId: '',
        name: tool['name'],
        description: text(tool['description']),
        ...('string' === typeof tool['description'] &&
        tool['description'].length > WebMcpLimits.TEXT
          ? { descriptionTruncated: true }
          : {}),
        origin: text(tool['origin']) || location.origin,
        frameId: this.#frames.get(frame) ?? 0,
        revision,
        annotations,
        inputSchemaJson,
      };
      const signature = JSON.stringify(metadata);
      const old = previous.find((entry) => entry.signature === signature);
      metadata.toolId = old?.metadata.toolId ?? `${this.#id}:${++this.#next}`;
      entries.push({ raw: value as object, metadata, signature });
    }
    this.#entries = entries;
    return true;
  }

  #select(toolId: string | undefined, name: string | undefined): Entry {
    const matches = this.#entries.filter((e) =>
      toolId !== undefined ? e.metadata.toolId === toolId : e.metadata.name === name,
    );
    if (matches.length > 1)
      throw new Error('WebMCP tool name is ambiguous; discover and select a toolId');
    const found = matches[0];
    if (found === undefined) {
      if (toolId !== undefined)
        throw new Error('WebMCP toolId is stale or belongs to another document; discover again');
      throw new Error(
        `no WebMCP tool '${name ?? ''}' on this page; registered: ${
          this.#entries
            .slice(0, WebMcpLimits.PAGE)
            .map((e) => e.metadata.name)
            .join(', ') || 'none'
        }`,
      );
    }
    return found;
  }

  async discover(input: unknown): Promise<WebMcpCatalog> {
    const args = WebMcpDiscoverySchema.parse(input);
    if (args.toolId !== undefined && args.tool !== undefined)
      throw new Error('WebMCP discovery accepts toolId or tool, not both');
    const secureContext = true === globalThis.isSecureContext;
    let available: boolean;
    try {
      available = await this.#refresh(args.fromOrigins, args.toolId !== undefined);
    } catch (error) {
      const denied =
        'SecurityError' === fields(error)['name'] || 'NotAllowedError' === fields(error)['name'];
      return {
        status: denied ? WebMcpStatus.DENIED : WebMcpStatus.UNSUPPORTED,
        secureContext,
        total: 0,
        tools: [],
        reason: denied
          ? 'WebMCP discovery was denied by the browser permissions policy'
          : 'WebMCP discovery failed or its registry/API shape is unsupported; check browser configuration and retry discovery',
      };
    }
    if (!available)
      return {
        status: WebMcpStatus.UNAVAILABLE,
        secureContext,
        total: 0,
        tools: [],
        reason:
          'WebMCP (document.modelContext) is unavailable; check browser support, secure context, site registration and permissions. Ordinary Reticle UI actions remain available.',
      };
    const detail = args.toolId !== undefined || args.tool !== undefined;
    const selected = detail
      ? [this.#select(args.toolId, args.tool)]
      : this.#entries.slice(args.offset, args.offset + args.limit);
    const next = args.offset + selected.length;
    return {
      status: WebMcpStatus.AVAILABLE,
      secureContext,
      ...(this.#api === undefined ? {} : { api: this.#api }),
      total: this.#entries.length,
      tools: selected.map(({ metadata }) => {
        if (detail) return { ...metadata };
        const { inputSchemaJson: _schema, ...summary } = metadata;
        return summary;
      }),
      ...(!detail && next < this.#entries.length ? { nextOffset: next } : {}),
    };
  }

  async execute(input: unknown): Promise<Record<string, unknown>> {
    const args = WebMcpArgsSchema.parse(input);
    const json = webMcpJson(args.params);
    const deadline = nativeNow() + args.timeoutMs;
    if (
      !(await this.#refresh(
        args.fromOrigins,
        args.toolId !== undefined,
        Math.min(args.timeoutMs, WebMcpLimits.TIMEOUT_MS),
      ))
    ) {
      throw new Error('WebMCP (document.modelContext) not available on this page');
    }
    const entry = this.#select(args.toolId, args.tool);
    if (
      (requiresDangerousConfirmation(entry.metadata.name) ||
        true === entry.metadata.annotations.consequentialHint) &&
      !args.confirmDangerous
    ) {
      throw new Error(
        `potentially destructive WebMCP tool blocked; retry with ${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
      );
    }
    const mc = this.#context;
    if (mc === undefined) throw new Error('WebMCP context disappeared before dispatch');
    const remaining = deadline - nativeNow();
    if (remaining <= 0)
      throw new Error('WebMCP timed out during discovery; no tool was dispatched');
    const controller = new AbortController();
    let result: unknown;
    try {
      result = await bounded(
        () =>
          mc.executeTool(
            entry.raw,
            args.inputEncoding === WebMcpEncoding.JSON ? json : (JSON.parse(json) as unknown),
            { signal: controller.signal },
          ),
        remaining,
        controller,
      );
    } catch {
      throw new Error(
        'WebMCP execution did not complete successfully; effects may have occurred. Inspect the app before retrying.',
      );
    }
    // Native results may be JSON text. Sanitize the parsed value too so nested secrets do not
    // escape redaction just because the browser encoded its result as a string.
    if ('string' === typeof result && result.length > WebMcpLimits.JSON) {
      return {
        ok: true,
        action: ActionType.WEBMCP,
        inputMode: InputMode.WEBMCP,
        dispatched: true,
        toolId: entry.metadata.toolId,
        tool: entry.metadata.name,
        toolResult: null,
        resultOmitted: true,
        warning: `${ActionWarning.WEBMCP_SELF_REPORTED}; oversized tool output omitted`,
      };
    }
    let normalized = result;
    if ('string' === typeof result && result.length <= WebMcpLimits.JSON) {
      try {
        normalized = JSON.parse(result) as unknown;
      } catch {
        /* Plain text is valid output. */
      }
    }
    const sanitized = sanitizeWithReport(normalized);
    const toolResult =
      'string' === typeof result && normalized !== result
        ? JSON.stringify(sanitized.value)
        : sanitized.value;
    return {
      ok: true,
      action: ActionType.WEBMCP,
      inputMode: InputMode.WEBMCP,
      dispatched: true,
      toolId: entry.metadata.toolId,
      tool: entry.metadata.name,
      toolResult,
      ...(sanitized.truncation === undefined ? {} : { truncation: sanitized.truncation }),
      warning: ActionWarning.WEBMCP_SELF_REPORTED,
    };
  }
}
