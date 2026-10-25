/**
 * `reticle_session { action: "end" }` on a leased tab releases that lease.
 *
 * Found driving over MCP: an agent leased a tab, ended its session, and the lease stayed connected
 * until the reaper took it. Every id-less call from the next agent was refused as ambiguous for up
 * to the lease TTL, although `end` says it terminates the session for good.
 */

import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';

const LEASED = 'lease-abc';
const OWNER = 'agent-1';

function endTool() {
  const tool = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.END_SESSION);
  if (tool === undefined) {throw new Error('reticle_end_session is not defined');}
  return tool;
}

/** One connected tab, and a pool whose only lease is `LEASED`, taken by `leaseOwner`. */
function harness(sessionId: string, leaseOwner: string) {
  const released: string[] = [];
  const session = {
    id: sessionId,
    setState: () => undefined,
    readJournalActions: () => Promise.resolve([]),
  };
  const pool = {
    heldBy: (id: string, owner: string | undefined) => LEASED === id && leaseOwner === owner,
    release: (id: string) => {
      released.push(id);
      return Promise.resolve();
    },
    activeCount: () => 0,
  };
  const deps = {
    attachId: OWNER,
    pool,
    sessions: {
      count: () => 1,
      get: (id: string) => (sessionId === id ? session : undefined),
      departed: () => undefined,
      resolve: () => session,
      all: () => [session],
    },
  };
  return { deps, released };
}

describe('ending a leased session releases its lease', () => {
  it('releases the lease through the pool and says so', async () => {
    const { deps, released } = harness(LEASED, OWNER);

    const result = (await endTool().handler(deps as never, {})) as Record<string, unknown>;

    expect(released).toEqual([LEASED]);
    expect(result['leaseReleased']).toBe(true);
  });

  it('releases nothing when the ended session is not a lease', async () => {
    const { deps, released } = harness('s-human-tab', OWNER);

    const result = (await endTool().handler(deps as never, {})) as Record<string, unknown>;

    expect(released).toEqual([]);
    expect(result['leaseReleased']).toBeUndefined();
  });

  it("never releases another agent's lease", async () => {
    const { deps, released } = harness(LEASED, 'agent-2');

    const result = (await endTool().handler(deps as never, { sessionId: LEASED })) as Record<
      string,
      unknown
    >;

    expect(released).toEqual([]);
    expect(result['leaseReleased']).toBeUndefined();
  });
});
