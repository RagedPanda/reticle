import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReticleCommand, InputMode } from '@reticlehq/core';
import { WebMcpStatus } from '@reticlehq/core/webmcp';
import { createCommandRegistry } from '@/commands/commands.js';

function fixture(
  tools: Record<string, unknown>[] = [{ name: 'search', inputSchema: { type: 'object' } }],
) {
  const mc = Object.assign(new EventTarget(), {
    getTools: vi.fn(() => Promise.resolve(tools)),
    executeTool: vi.fn((_tool: object, _input: unknown, _options: unknown) =>
      Promise.resolve<unknown>({ ok: true }),
    ),
  });
  Object.defineProperty(document, 'modelContext', { value: mc, configurable: true });
  const registry = createCommandRegistry();
  const discover = (args: Record<string, unknown> = {}) =>
    registry.get(ReticleCommand.WEBMCP)?.(args);
  const act = (args: Record<string, unknown>) =>
    registry.get(ReticleCommand.ACT)?.({ action: 'webmcp', args });
  return { mc, discover, act };
}
afterEach(() => {
  delete (document as unknown as Record<string, unknown>)['modelContext'];
});

describe('WebMCP discovery and execution', () => {
  it('discovers tools registered before attachment without executing them', async () => {
    const { discover, mc } = fixture();
    expect(await discover()).toMatchObject({
      status: WebMcpStatus.AVAILABLE,
      total: 1,
      tools: [{ name: 'search' }],
    });
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('preserves schema property names and original descriptor identity', async () => {
    const tool = {
      name: 'search',
      inputSchema: { type: 'object', properties: { password: { type: 'string' } } },
    };
    const { discover, act, mc } = fixture([tool]);
    const catalog = (await discover()) as { tools: { toolId: string }[] };
    const toolId = catalog.tools[0]?.toolId;
    const detail = (await discover({ toolId })) as { tools: { inputSchemaJson: string }[] };
    expect(JSON.parse(detail.tools[0]?.inputSchemaJson ?? '{}')).toEqual(tool.inputSchema);
    expect(await act({ toolId, params: { q: 'x' } })).toMatchObject({
      inputMode: InputMode.WEBMCP,
      dispatched: true,
    });
    expect(mc.executeTool.mock.calls[0]?.[0]).toBe(tool);
  });
  it('refuses ambiguous names rather than picking the first frame', async () => {
    const { act, mc } = fixture([{ name: 'search' }, { name: 'search' }]);
    await expect(act({ tool: 'search' })).rejects.toThrow(/ambiguous/);
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('invalidates a discovered handle on toolchange', async () => {
    const { discover, act, mc } = fixture();
    const catalog = (await discover()) as { tools: { toolId: string }[] };
    mc.dispatchEvent(new Event('toolchange'));
    await expect(act({ toolId: catalog.tools[0]?.toolId })).rejects.toThrow(/stale/);
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('refuses malformed parameters before any tool executes', async () => {
    const { act, mc } = fixture();
    await expect(act({ tool: 'search', params: [] })).rejects.toThrow();
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('honors consequential annotations even for an innocuous name', async () => {
    const { act, mc } = fixture([{ name: 'continue', annotations: { consequentialHint: true } }]);
    await expect(act({ tool: 'continue' })).rejects.toThrow(/confirmDangerous/);
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('never retries a rejected call with a different encoding', async () => {
    const { act, mc } = fixture();
    mc.executeTool.mockRejectedValue(new Error('after side effect'));
    await expect(act({ tool: 'search', params: {} })).rejects.toThrow(/may have occurred/);
    expect(mc.executeTool).toHaveBeenCalledTimes(1);
  });
  it('paginates summaries and only includes a schema in a detail response', async () => {
    const { discover } = fixture(Array.from({ length: 23 }, (_, i) => ({ name: `tool${i}` })));
    const page = (await discover()) as { tools: object[] };
    expect(page).toMatchObject({ total: 23, nextOffset: 20 });
    expect(page.tools).toHaveLength(20);
    expect(page.tools[0]).not.toHaveProperty('inputSchemaJson');
    expect(await discover({ offset: 20 })).toMatchObject({
      tools: [{ name: 'tool20' }, { name: 'tool21' }, { name: 'tool22' }],
    });
  });
  it('invalidates the handle when its schema changes without a toolchange event', async () => {
    const tool = { name: 'search', inputSchema: { type: 'object', required: [] as string[] } };
    const { discover, act, mc } = fixture([tool]);
    const catalog = (await discover()) as { tools: { toolId: string }[] };
    tool.inputSchema.required.push('query');
    await expect(act({ toolId: catalog.tools[0]?.toolId })).rejects.toThrow(/stale/);
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it('refuses handles from a previous document registry', async () => {
    const previous = fixture();
    const catalog = (await previous.discover()) as { tools: { toolId: string }[] };
    const current = fixture();
    await expect(current.act({ toolId: catalog.tools[0]?.toolId })).rejects.toThrow(/stale/);
    expect(current.mc.executeTool).not.toHaveBeenCalled();
  });
  it('distinguishes unavailable, unsupported and denied discovery', async () => {
    const { mc, discover } = fixture();
    mc.getTools.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    expect(await discover()).toMatchObject({ status: WebMcpStatus.DENIED });
    Object.defineProperty(document, 'modelContext', {
      value: { registerTool() {} },
      configurable: true,
    });
    expect(await discover()).toMatchObject({ status: WebMcpStatus.UNSUPPORTED });
    delete (document as unknown as Record<string, unknown>)['modelContext'];
    expect(await discover()).toMatchObject({ status: WebMcpStatus.UNAVAILABLE });
  });
  it('uses an explicitly selected JSON encoding exactly once', async () => {
    const { act, mc } = fixture();
    await act({ tool: 'search', params: { q: 'x' }, inputEncoding: 'json' });
    expect(mc.executeTool).toHaveBeenCalledTimes(1);
    expect(mc.executeTool.mock.calls[0]?.[1]).toBe('{"q":"x"}');
  });
  it('requests cancellation on timeout and never retries the action', async () => {
    const { act, mc } = fixture();
    mc.executeTool.mockImplementation(() => new Promise(() => {}));
    await expect(act({ tool: 'search', timeoutMs: 20 })).rejects.toThrow(/may have occurred/);
    expect(mc.executeTool).toHaveBeenCalledTimes(1);
    expect((mc.executeTool.mock.calls[0]?.[2] as { signal: AbortSignal }).signal.aborted).toBe(
      true,
    );
  });
  it('redacts nested JSON output and omits oversized strings', async () => {
    const { act, mc } = fixture();
    mc.executeTool.mockResolvedValue(JSON.stringify({ password: 'private-value', ok: true }));
    const result = await act({ tool: 'search' });
    expect(JSON.stringify(result)).not.toContain('private-value');
    mc.executeTool.mockResolvedValue('x'.repeat(16001) + 'private-value');
    expect(await act({ tool: 'search' })).toMatchObject({ resultOmitted: true, toolResult: null });
  });

  it('does not dispatch when discovery exhausts the action budget', async () => {
    const { act, mc } = fixture();
    mc.getTools.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ name: 'search' }]), 40)),
    );
    await expect(act({ tool: 'search', timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(mc.executeTool).not.toHaveBeenCalled();
  });
  it.each([null, [], 'object', false].map((inputSchema) => ({ inputSchema })))(
    'refuses a malformed declared input schema: $inputSchema',
    async ({ inputSchema }) => {
      const { discover, act, mc } = fixture([{ name: 'search', inputSchema }]);
      expect(await discover()).toMatchObject({ status: WebMcpStatus.UNSUPPORTED, tools: [] });
      await expect(act({ tool: 'search', params: { q: 'x' } })).rejects.toThrow(/input schema/);
      expect(mc.executeTool).not.toHaveBeenCalled();
    },
  );
});
