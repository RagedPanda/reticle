import { ActionType, ActionWarning, DANGEROUS_ACTION_CONFIRM_ARG } from '@reticlehq/core';
import { requiresDangerousConfirmation } from './danger-context.js';

interface WebMcpTool {
  name: string;
}
interface ModelContext {
  getTools?: () => Promise<WebMcpTool[]>;
  executeTool?: (tool: WebMcpTool, input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The page's WebMCP registry. The explainer moved it from `navigator` to `document`; Chrome keeps
 * the `navigator` name as a deprecated alias, so both are read, current name first.
 */
function modelContext(): ModelContext | undefined {
  const read = (host: object): ModelContext | undefined =>
    (host as { modelContext?: ModelContext }).modelContext;
  return read(document) ?? read(navigator);
}

/**
 * Invoke a tool the site registered with WebMCP.
 *
 * The spec has no call-by-name method: a tool is discovered with `getTools()` and the discovered
 * object is handed back to `executeTool()`. What the tool returns is the site's own account of the
 * call, so it goes back as `toolResult` beside a warning, never as the action's outcome — whether the
 * tool did what it claims is for an independent channel to show.
 */
export async function dispatchWebMcp(
  tool: string,
  params: Record<string, unknown>,
  confirmDangerous = false,
): Promise<Record<string, unknown>> {
  if (requiresDangerousConfirmation(tool) && !confirmDangerous) {
    throw new Error(
      `potentially destructive WebMCP tool blocked; retry with ${DANGEROUS_ACTION_CONFIRM_ARG}=true`,
    );
  }
  const mc = modelContext();
  if (typeof mc?.getTools !== 'function' || typeof mc.executeTool !== 'function') {
    throw new Error('WebMCP (document.modelContext) not available on this page');
  }
  const tools = await mc.getTools();
  const found = tools.find((t) => t.name === tool);
  if (found === undefined) {
    const names = tools.map((t) => t.name).join(', ');
    throw new Error(`no WebMCP tool '${tool}' on this page; registered: ${names || 'none'}`);
  }
  const toolResult = await mc.executeTool(found, params);
  return {
    ok: true,
    action: ActionType.WEBMCP,
    dispatched: true,
    toolResult,
    warning: ActionWarning.WEBMCP_SELF_REPORTED,
  };
}
