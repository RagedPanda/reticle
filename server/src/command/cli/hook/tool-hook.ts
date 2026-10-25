/**
 * `reticle hook tool --agent <id>`: keep one of the coding agent's own tool calls.
 *
 * The agent's shell commands, file edits and web fetches never pass through Reticle's MCP tools,
 * so the daemon's episode log never saw them. The agent's post-tool hook hands each one over here.
 * It goes into the same `.reticle/episodes/` folder, one file per agent session
 * (`agent-<session>.jsonl`): the tool, its arguments, a head of its result and the result's size,
 * whether it failed, its exit code, and its timing. Every string passes the secret redaction first.
 *
 * LOCAL ONLY, under the same rules as the episode log: gitignored, swept by retention, never read
 * by the sync, and off with the journal (`RETICLE_JOURNAL=0`, `"journal": false`). Reticle's own
 * MCP tools are skipped, because the daemon already keeps them in full. Never throws.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { projectSetting, redactSecrets } from '@/memory/intent/record-request.js';
import { EPISODE_FILE_VERSION } from '@/memory/journal/episode-log.js';
import { captureRoots } from './prompt-hook.js';

/** The `kind` of a record this hook writes, beside the daemon's `start` and `call`. */
export const AGENT_TOOL_RECORD = 'agent_tool';
/** A result keeps this many characters; its full size is kept beside it. */
export const MAX_TOOL_TEXT = 4_000;
/** One argument string (a whole file a Write sends) keeps this many characters. */
const MAX_ARG_TEXT = 100_000;
/** Reticle's own tools, by the MCP name prefix every agent gives them. */
const RETICLE_TOOL = /^mcp__reticle/i;
const EXIT_CODE = /^Exit code (\d+)/;
const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);
const JOURNAL_SETTING = 'journal';
const UNKNOWN_SESSION = 'unknown';
const AGENT_FILE_PREFIX = 'agent-';
const BASH = 'Bash';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.length ? value : undefined;

/**
 * Every string redacted and capped, at any depth. Says whether any string was cut. Paths inside the
 * project are made relative to it first: the redaction removes an absolute path whole, because a
 * home folder names a person, and the file an edit touched is the point of the record.
 */
function redacted(value: unknown, cut: { any: boolean }, base: string): unknown {
  if ('string' === typeof value) {
    if (value.length > MAX_ARG_TEXT) {cut.any = true;}
    return redactSecrets(value.split(`${base}/`).join(''), MAX_ARG_TEXT);
  }
  if (Array.isArray(value)) {return value.map((item) => redacted(item, cut, base));}
  if (!isObject(value)) {return value;}
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v, cut, base)]));
}

/** A result as kept: its redacted head, its full size, and whether the head is all of it. */
function resultOf(
  value: unknown,
  base: string,
): { head: string; chars: number; truncated: boolean } {
  const full = 'string' === typeof value ? value : JSON.stringify(value ?? null);
  return {
    head: redactSecrets(full.split(`${base}/`).join(''), MAX_TOOL_TEXT),
    chars: full.length,
    truncated: full.length > MAX_TOOL_TEXT,
  };
}

/** One record from a post-tool payload (Claude Code's shape), or undefined when it is not one. */
/** A failed call keeps the exit code its error text names; a Bash call that succeeded exited 0. */
function exitCodeOf(exit: string | undefined, ok: boolean, tool: string): { exitCode?: number } {
  if (exit !== undefined) {
    return { exitCode: Number(exit) };
  }
  if (ok && BASH === tool) {
    return { exitCode: 0 };
  }
  return {};
}

export function toolRecordFrom(
  agent: string,
  payload: unknown,
  now: number,
  base: string,
): Json | undefined {
  if (!isObject(payload)) {return undefined;}
  const tool = text(payload['tool_name']);
  if (tool === undefined || RETICLE_TOOL.test(tool)) {return undefined;}
  const error = text(payload['error']);
  const ok = error === undefined;
  const duration = payload['duration_ms'];
  const durationMs = 'number' === typeof duration && duration >= 0 ? duration : undefined;
  const exit = error === undefined ? undefined : EXIT_CODE.exec(error)?.[1];
  const cut = { any: false };
  const args = redacted(payload['tool_input'] ?? {}, cut, base);
  return {
    v: EPISODE_FILE_VERSION,
    kind: AGENT_TOOL_RECORD,
    agent,
    ...(text(payload['session_id']) === undefined ? {} : { agentSession: payload['session_id'] }),
    ...(text(payload['tool_use_id']) === undefined ? {} : { toolUseId: payload['tool_use_id'] }),
    tool,
    args,
    ...(cut.any ? { argsTruncated: true } : {}),
    ok,
    ...(ok
      ? { result: resultOf(payload['tool_response'], base) }
      : { error: resultOf(error, base) }),
    ...exitCodeOf(exit, ok, tool),
    ...(true === payload['is_interrupt'] ? { interrupted: true } : {}),
    ...(durationMs === undefined ? {} : { startedAt: now - durationMs, durationMs }),
    endedAt: now,
  };
}

interface CaptureIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
}

/** Keep one tool call. Never throws: the `.reticle` roots it wrote to, or none. */
export function captureToolCall(agent: string, raw: string, io: CaptureIo): { written: string[] } {
  try {
    if (OFF_VALUES.has((io.env[ReticleEnv.JOURNAL] ?? '').toLowerCase())) {return { written: [] };}
    const payload: unknown = JSON.parse(raw);
    if (!isObject(payload)) {return { written: [] };}
    const cwd = text(payload['cwd']) ?? io.cwd;
    const record = toolRecordFrom(agent, payload, io.now(), cwd);
    if (record === undefined) {return { written: [] };}
    const session = (text(payload['session_id']) ?? UNKNOWN_SESSION).replace(/[^\w-]/g, '_');
    const line = `${JSON.stringify(record)}\n`;
    const written: string[] = [];
    for (const root of captureRoots(cwd)) {
      if (false === projectSetting(dirname(root), JOURNAL_SETTING)) {continue;}
      const dir = join(root, ReticleDir.EPISODES_SUBDIR);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${AGENT_FILE_PREFIX}${session}.jsonl`), line);
      written.push(root);
    }
    return { written };
  } catch {
    return { written: [] };
  }
}
