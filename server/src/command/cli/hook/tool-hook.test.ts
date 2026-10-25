/**
 * `reticle hook tool --agent <id>`: what an agent's post-tool hook runs.
 *
 * The coding agent's own calls (a shell command, a file edit, a web fetch) never pass through
 * Reticle's MCP tools, so the episode log saw none of them. The hook keeps each one locally, with
 * secrets redacted, and never stands in the agent's way: a bad payload is nothing written, exit 0.
 */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { AGENT_TOOL_RECORD, MAX_TOOL_TEXT, captureToolCall } from './tool-hook.js';

function project(config: Record<string, unknown> = { projectId: 'shop-1' }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-tool-hook-')));
  writeFileSync(join(dir, '.reticle.json'), JSON.stringify(config));
  return dir;
}

const records = (dir: string): Record<string, unknown>[] => {
  const episodes = join(dir, ReticleDir.ROOT, ReticleDir.EPISODES_SUBDIR);
  return readdirSync(episodes).flatMap((file) =>
    readFileSync(join(episodes, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
};

const run = (payload: unknown, env: NodeJS.ProcessEnv = {}) =>
  captureToolCall('claude-code', JSON.stringify(payload), {
    cwd: '/nowhere',
    env,
    now: () => 10_000,
  });

describe("the coding agent's own tool calls", () => {
  it('keeps a failed shell command with its exit code, timing and redacted output', () => {
    const dir = project();
    const written = run({
      session_id: 'sess-1',
      cwd: dir,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnop1234" x' },
      error: 'Exit code 7\ncould not connect',
      duration_ms: 420,
    });
    expect(written.written).toHaveLength(1);
    const [record] = records(dir);
    expect(record).toMatchObject({
      kind: AGENT_TOOL_RECORD,
      agent: 'claude-code',
      agentSession: 'sess-1',
      toolUseId: 'toolu_1',
      tool: 'Bash',
      ok: false,
      exitCode: 7,
      startedAt: 9_580,
      endedAt: 10_000,
      durationMs: 420,
    });
    expect(JSON.stringify(record)).not.toContain('sk-live-abcdefghijklmnop1234');
  });

  it('keeps an edit whole and a large result as its head and its size', () => {
    const dir = project();
    const big = 'y'.repeat(MAX_TOOL_TEXT * 3);
    run({
      session_id: 's',
      cwd: dir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `${dir}/a.ts`, old_string: 'a', new_string: 'b' },
      tool_response: { filePath: `${dir}/a.ts`, body: big },
      duration_ms: 3,
    });
    const [record] = records(dir);
    expect(record).toMatchObject({
      tool: 'Edit',
      ok: true,
      args: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
    });
    const result = record?.['result'] as { head: string; chars: number; truncated: boolean };
    expect(result.truncated).toBe(true);
    expect(result.head.length).toBe(MAX_TOOL_TEXT);
    expect(result.chars).toBeGreaterThan(MAX_TOOL_TEXT * 3);
  });

  it("skips Reticle's own tools: the daemon already keeps them in full", () => {
    const dir = project();
    expect(
      run({ cwd: dir, tool_name: 'mcp__reticle__reticle_act', tool_input: {}, tool_response: {} })
        .written,
    ).toEqual([]);
  });

  it('writes nothing when the journal is off, outside a project, or on a bad payload', () => {
    const dir = project({ projectId: 'p', journal: false });
    const call = { cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} };
    expect(run(call).written).toEqual([]);
    expect(run({ ...call, cwd: project() }, { RETICLE_JOURNAL: '0' }).written).toEqual([]);
    expect(run({ ...call, cwd: realpathSync(tmpdir()) }).written).toEqual([]);
    expect(
      captureToolCall('claude-code', 'not json', { cwd: dir, env: {}, now: () => 0 }).written,
    ).toEqual([]);
  });
});
