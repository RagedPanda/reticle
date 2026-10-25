/**
 * A journey step is described over the window its verdict was taken in.
 *
 * Found driving over MCP: a step that declared `net POST /api/generate-script status 200`
 * waited 1.5s for the answer and reported `held: true` — and beside it a `request-never-settled`
 * contradiction, "1 request(s) were still in flight", for that same request. The effect was read
 * the instant the click dispatched, before the wait the verdict came from. A pass carrying a
 * contradiction about itself reads as a possible false green, and that is what an agent and the
 * Reticle result block were handed.
 */
import { describe, expect, it } from 'vitest';
import {
  EventType,
  ReticleTool,
  SessionState,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const ROOT = '/tmp/reticle-act-sequence-step-window/.reticle';
const URL = 'http://localhost:8787/api/generate-script';
const ANSWER_AFTER_MS = 40;

/** A page where the click starts a POST that answers {@link ANSWER_AFTER_MS} later. */
function slowWriteSession(answers = true): Session {
  const start = Date.now();
  const clock = (): number => Date.now() - start;
  const events: ReticleEvent[] = [];
  const listeners = new Set<(event: ReticleEvent) => void>();
  const push = (type: EventType, data: Record<string, unknown>): void => {
    const event = { t: clock(), type, sessionId: 's1', data } as ReticleEvent;
    events.push(event);
    for (const listener of listeners) {listener(event);}
  };
  const command = (): Promise<CommandResult> => {
    push(EventType.DOM_TEXT, { text: 'Generating…' });
    push(EventType.NET_PENDING, { id: 'r1', method: 'POST', url: URL });
    push(EventType.SIGNAL, { name: 'generate:started' });
    if (answers)
      {setTimeout(() => {
        push(EventType.NET_REQUEST, {
          id: 'r1',
          method: 'POST',
          url: URL,
          status: 200,
          ok: true,
          durationMs: ANSWER_AFTER_MS,
          initiator: 'fetch',
        });
      }, ANSWER_AFTER_MS);}
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { ref: 'e1', action: 'click', dispatched: true, settled: true, settleReason: null },
    });
  };
  const stub: Partial<Session> = {
    id: 's1',
    url: 'http://localhost:4312/compose',
    elapsed: clock,
    lastAct: new LastAct(),
    beginAction: () => 'a0',
    finishAction: () => undefined,
    recordAction: () => 'a1',
    readJournalActions: () => Promise.resolve([]),
    setState: () => undefined,
    command,
    queryEvents: () => Promise.resolve(events),
    eventsSince: (since: number) => events.filter((e) => e.t >= since),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: (listener: (event: ReticleEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return stub as Session;
}

function depsFor(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    get: () => session,
    count: () => 1,
    departed: () => undefined,
  };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  };
}

const sequence = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);

describe('a declared step that waited for its answer', () => {
  it('does not report the answered request as still in flight', async () => {
    if (sequence === undefined) {throw new Error('no act_sequence tool');}
    const session = slowWriteSession();
    const result = (await sequence.handler(depsFor(session), {
      steps: [
        {
          ref: 'e1',
          action: 'click',
          expect: { kind: 'net', method: 'POST', urlContains: '/api/generate-script', status: 200 },
        },
      ],
      timeout_ms: 2000,
    })) as { verified: string; steps: { held?: boolean; contradictions?: unknown[] }[] };
    expect(result.steps[0]?.held).toBe(true);
    expect(result.steps[0]?.contradictions).toBeUndefined();
    expect(result.verified).toBe('yes');
  });

  // The fix must not be "stop attaching contradictions": a request that NEVER answers, beside a
  // step whose declared signal held, is still reported in flight.
  it('still reports a request that never answered', async () => {
    if (sequence === undefined) {throw new Error('no act_sequence tool');}
    const result = (await sequence.handler(depsFor(slowWriteSession(false)), {
      steps: [{ ref: 'e1', action: 'click', expect: { kind: 'signal', name: 'generate:started' } }],
      timeout_ms: 2000,
    })) as { steps: { held?: boolean; contradictions?: { kind: string }[] }[] };
    expect(result.steps[0]?.held).toBe(true);
    expect(result.steps[0]?.contradictions?.map((c) => c.kind)).toContain('request-never-settled');
  });
});
