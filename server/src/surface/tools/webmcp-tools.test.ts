import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionType, ReticleCommand, ReticleTool, asRecord } from '@reticlehq/core';
import { WebMcpStatus } from '@reticlehq/core/webmcp';
import { createFakeSession } from '@/portal/session/fake-session.js';
import { MERGED_TOOLS, TOOLS, type ToolDeps } from './tools.js';
import { actCommand } from './act-tools.js';
import { createMcpServer } from '@/surface/mcp/mcp.js';
import { TOOL_SURFACE } from './tool-surface.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateWebMcpInput } from './act/webmcp-validation.js';
import { resolveActTarget } from './act/act-target.js';

const catalog = {
  status: WebMcpStatus.AVAILABLE,
  api: 'document',
  secureContext: true,
  total: 1,
  tools: [
    {
      toolId: 'document:1',
      name: 'search',
      description: '',
      origin: 'https://example.test',
      frameId: 0,
      revision: 0,
      annotations: {},
      inputSchemaJson: JSON.stringify({
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1 } },
        required: ['count'],
        additionalProperties: false,
      }),
    },
  ],
};
function setup() {
  const command = vi.fn((name: string, _args: Record<string, unknown>, _timeoutMs?: number) =>
    Promise.resolve({
      kind: 'command_result' as const,
      id: 'test',
      ok: true,
      result:
        name === ReticleCommand.WEBMCP
          ? catalog
          : {
              dispatched: true,
              inputMode: 'webmcp',
              toolResult: { ok: true },
              warning: 'self-reported',
            },
    }),
  );
  const session = createFakeSession({ command });
  const deps = { now: () => 0, sessions: { resolve: () => session } } as unknown as ToolDeps;
  return { session, deps, command };
}
describe('WebMCP through Reticle tools', () => {
  it('is discoverable through both the merged and full surfaces', async () => {
    const { deps, command } = setup();
    const look = MERGED_TOOLS.find((t) => t.name === ReticleTool.LOOK);
    const direct = TOOLS.find((t) => t.name === ReticleTool.WEBMCP);
    expect(look).toBeDefined();
    expect(direct).toBeDefined();
    expect(await look?.handler(deps, { action: 'webmcp', tool: 'search' })).toEqual(catalog);
    expect(command).toHaveBeenCalledWith(
      ReticleCommand.WEBMCP,
      expect.objectContaining({ tool: 'search' }),
    );
    expect(z.object(direct?.outputSchema ?? {}).parse(catalog)).toEqual(catalog);
  });
  it('does not require or query an element ref', async () => {
    const { session, command } = setup();
    expect(await resolveActTarget(session, { action: ActionType.WEBMCP })).toEqual({
      kind: 'global',
      ref: '',
    });
    expect(command).not.toHaveBeenCalled();
  });
  it('validates input and dispatches the exact discovered id once', async () => {
    const { session, deps, command } = setup();
    await actCommand(deps, session, {
      action: ActionType.WEBMCP,
      args: { tool: 'search', params: { count: 2 } },
    });
    expect(command.mock.calls.map((c) => c[0])).toEqual([
      ReticleCommand.WEBMCP,
      ReticleCommand.ACT,
    ]);
    expect(command.mock.calls[1]?.[1]).toMatchObject({
      args: { toolId: 'document:1', params: { count: 2 } },
    });
    expect(command.mock.calls[1]?.[1]['args']).not.toHaveProperty('tool');
  });
  it('refuses a schema violation before dispatch and does not coerce it', async () => {
    const { session, deps, command } = setup();
    await expect(
      actCommand(deps, session, {
        action: ActionType.WEBMCP,
        args: { tool: 'search', params: { count: '2' } },
      }),
    ).rejects.toThrow(/schema/);
    expect(command.mock.calls.map((c) => c[0])).toEqual([ReticleCommand.WEBMCP]);
  });
  it('rejects malformed parameters before discovery', async () => {
    const { session, deps, command } = setup();
    await expect(
      actCommand(deps, session, {
        action: ActionType.WEBMCP,
        args: { tool: 'search', params: [] },
      }),
    ).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });
  it.each([TOOL_SURFACE.MERGED, TOOL_SURFACE.ALL])(
    'discovers across an MCP transport on %s',
    async (surface) => {
      const { deps } = setup();
      const server = createMcpServer(deps, surface);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'webmcp-test', version: '1' });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: surface === TOOL_SURFACE.ALL ? ReticleTool.WEBMCP : ReticleTool.LOOK,
          arguments: {
            ...(surface === TOOL_SURFACE.ALL ? {} : { action: 'webmcp' }),
            tool: 'search',
          },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(JSON.stringify(result)).toContain('document:1');
        expect(JSON.stringify(result)).toContain('inputSchemaJson');
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
  it('does not dispatch after preflight consumes a caller budget', async () => {
    const { session, deps, command } = setup();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(2000);
    await expect(
      actCommand(
        { ...deps, now },
        session,
        { action: ActionType.WEBMCP, args: { tool: 'search', params: { count: 1 } } },
        1000,
      ),
    ).rejects.toThrow(/budget/);
    expect(command.mock.calls.map((c) => c[0])).toEqual([ReticleCommand.WEBMCP]);
  });
  it('rejects unsupported schema semantics before execution', async () => {
    await expect(
      validateWebMcpInput('{"type":"object","unevaluatedProperties":false}', {}),
    ).rejects.toThrow(/unsupported/);
    await expect(validateWebMcpInput('{"$ref":"https://example.test/schema"}', {})).rejects.toThrow(
      /remote/,
    );
    await expect(
      validateWebMcpInput(
        '{"type":"object","properties":{"value":{"type":"string","format":"unknown"}}}',
        { value: 'x' },
      ),
    ).rejects.toThrow(/format/);
  });
  it('does not turn a successful self-report into a verified consequence through MCP', async () => {
    const { deps, command } = setup();
    const root = await mkdtemp(join(tmpdir(), 'reticle-webmcp-test-'));
    const fs = createNodeFileSystem();
    const completeDeps = {
      ...deps,
      fs,
      reticleRoot: root,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      annotations: new AnnotationStore(),
      flows: new FlowStore(fs, root, { now: deps.now }),
      project: new ProjectStore(fs, root, { now: deps.now }),
    };
    const server = createMcpServer(completeDeps, TOOL_SURFACE.ALL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'webmcp-verdict-test', version: '1' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: ReticleTool.ACT_AND_WAIT,
        arguments: {
          action: ActionType.WEBMCP,
          args: { tool: 'search', params: { count: 1 } },
          until: { kind: 'net', method: 'POST', urlContains: '/cart', status: 200 },
          timeout_ms: 0,
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(['no', 'unknown']).toContain(asRecord(result.structuredContent)['verified']);
      expect(command.mock.calls.filter((c) => c[0] === ReticleCommand.ACT)).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
