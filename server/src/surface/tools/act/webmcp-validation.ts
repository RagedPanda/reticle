import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { ReticleCommand, type CommandResult } from '@reticlehq/core';
import {
  WebMcpArgsSchema,
  WebMcpCatalogSchema,
  WebMcpLimits,
  WebMcpStatus,
  webMcpJson,
  type WebMcpArgs,
} from '@reticlehq/core/webmcp';
import type { Session } from '@/portal/session/session.js';

// The SDK already supplies this validator as a public export and a locked dependency. A new
// worker per call prevents schema-id caching across sites and bounds hostile regex/recursive work.
const VALIDATOR = createRequire(import.meta.url).resolve(
  '@modelcontextprotocol/sdk/validation/ajv',
);
const VALIDATION_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { AjvJsonSchemaValidator } = require(workerData.validator);
  const validate = new AjvJsonSchemaValidator().getValidator(workerData.schema);
  parentPort.postMessage(validate(workerData.params).valid);
} catch { parentPort.postMessage(null); }
`;
const KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'items',
  'additionalItems',
  'maxItems',
  'minItems',
  'uniqueItems',
  'contains',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'dependencies',
  'propertyNames',
  'definitions',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
]);
const MAPS = new Set(['properties', 'patternProperties', 'definitions']);
const CHILDREN = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
]);
const LISTS = new Set(['allOf', 'anyOf', 'oneOf']);
const FORMATS = new Set([
  'date',
  'time',
  'date-time',
  'duration',
  'uri',
  'uri-reference',
  'uri-template',
  'url',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'regex',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
]);

/** Fail closed on schema features this validator would otherwise silently ignore. */
function supportedSchema(value: unknown): void {
  if ('boolean' === typeof value) return;
  if (null === value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('WebMCP input schema is malformed');
  const schema = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) throw new Error('WebMCP input schema uses an unsupported keyword');
    if (
      '$schema' === key &&
      child !== 'http://json-schema.org/draft-07/schema#' &&
      child !== 'https://json-schema.org/draft-07/schema'
    ) {
      throw new Error(
        'WebMCP input schema uses an unsupported dialect; currently draft-07 is supported',
      );
    }
    if ('$ref' === key && (typeof child !== 'string' || !child.startsWith('#')))
      throw new Error('WebMCP remote schema references are unsupported');
    if ('format' === key && (typeof child !== 'string' || !FORMATS.has(child)))
      throw new Error('WebMCP input schema format is unsupported');
    if (MAPS.has(key) || 'dependencies' === key) {
      if (null === child || typeof child !== 'object' || Array.isArray(child))
        throw new Error('WebMCP input schema map is malformed');
      for (const sub of Object.values(child)) {
        if ('dependencies' === key && Array.isArray(sub) && sub.every((v) => 'string' === typeof v))
          continue;
        supportedSchema(sub);
      }
    } else if (CHILDREN.has(key)) supportedSchema(child);
    else if (LISTS.has(key) || ('items' === key && Array.isArray(child))) {
      if (!Array.isArray(child)) throw new Error('WebMCP input schema list is malformed');
      child.forEach(supportedSchema);
    } else if ('items' === key) supportedSchema(child);
  }
}

export async function validateWebMcpInput(
  schemaJson: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (schemaJson.length > WebMcpLimits.JSON)
    throw new Error('WebMCP input schema exceeds the size limit');
  const schema: unknown = JSON.parse(schemaJson);
  webMcpJson(schema);
  webMcpJson(params);
  supportedSchema(schema);
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(VALIDATION_WORKER, {
      eval: true,
      workerData: { validator: VALIDATOR, schema, params },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error('WebMCP input schema validation exceeded its budget; no tool was dispatched'),
        ),
      WebMcpLimits.VALIDATION_MS,
    );
    worker.once('message', (valid: unknown) =>
      finish(
        true === valid
          ? undefined
          : new Error(
              false === valid
                ? 'WebMCP params do not match the input schema'
                : 'WebMCP input schema could not be validated',
            ),
      ),
    );
    worker.once('error', () =>
      finish(new Error('WebMCP input schema validator failed; no tool was dispatched')),
    );
    worker.once('exit', () => {
      if (!done) finish(new Error('WebMCP input schema validator exited without a result'));
    });
  });
}

/** Bind validation to a browser-owned handle, so a changed schema cannot reuse its approval. */
export async function prepareWebMcpArgs(
  session: Session,
  input: unknown,
  timeoutMs?: number,
): Promise<WebMcpArgs> {
  const args = WebMcpArgsSchema.parse(input);
  webMcpJson(args.params);
  const response = await session.command(
    ReticleCommand.WEBMCP,
    {
      ...(args.toolId === undefined ? { tool: args.tool } : { toolId: args.toolId }),
      ...(args.fromOrigins === undefined ? {} : { fromOrigins: args.fromOrigins }),
    },
    timeoutMs,
  );
  if (!response.ok) throw new Error('WebMCP discovery failed; no tool was dispatched');
  const catalog = WebMcpCatalogSchema.parse(response.result);
  if (catalog.status !== WebMcpStatus.AVAILABLE)
    throw new Error(catalog.reason ?? 'WebMCP unavailable');
  const selected = catalog.tools[0];
  if (catalog.tools.length !== 1 || selected?.inputSchemaJson === undefined)
    throw new Error('WebMCP discovery did not return one complete tool schema');
  await validateWebMcpInput(selected.inputSchemaJson, args.params);
  const { tool: _name, ...rest } = args;
  return { ...rest, toolId: selected.toolId };
}

/** Preserve a caller's total budget and let the browser report its own bounded timeout first. */
export async function dispatchWebMcp(
  session: Session,
  input: Record<string, unknown>,
  now: () => number,
  timeoutMs?: number,
): Promise<CommandResult> {
  const started = now();
  const args = await prepareWebMcpArgs(session, input['args'] ?? {}, timeoutMs);
  const remaining = timeoutMs === undefined ? Infinity : timeoutMs - (now() - started);
  const actionBudget = Math.floor(
    Math.min(args.timeoutMs, remaining - WebMcpLimits.BRIDGE_GRACE_MS),
  );
  if (actionBudget <= 0)
    throw new Error('WebMCP preflight exhausted the action budget; no tool was dispatched');
  return session.command(
    ReticleCommand.ACT,
    { ...input, args: { ...args, timeoutMs: actionBudget } },
    actionBudget + WebMcpLimits.BRIDGE_GRACE_MS,
  );
}
