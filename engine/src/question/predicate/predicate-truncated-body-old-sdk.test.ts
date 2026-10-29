/**
 * A truncated response body on a page whose SDK predates `networkBodyMaxChars` (#2031).
 *
 * SDKs before 3.3.0 cap every body at 8192 characters and ignore the option, so advice to raise it
 * sends an agent round a loop that cannot end. On such a page the only advice that works is updating
 * the SDK; a current page keeps the advice on how to raise the cap.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

const PREFIX = JSON.stringify({ status: 'ok', rows: 'x'.repeat(20_000) }).slice(0, 8192);

function bigResponse(): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'GET',
      url: 'https://app.test/api/big',
      status: 200,
      ok: true,
      responseBody: PREFIX,
      responseBodyTruncated: true,
    },
  } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  constructor(readonly sdkVersion: string | undefined) {}
  command(): Promise<never> {
    return Promise.reject(new Error('no element commands in these tests'));
  }
  eventsSince(): ReticleEvent[] {
    return [bigResponse()];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 100;
  }
}

const judge = (sdkVersion: string | undefined, clause: Record<string, unknown>) =>
  evaluatePredicate(new WindowSession(sdkVersion), {
    kind: 'net',
    urlContains: '/big',
    ...clause,
  });

describe('a truncated body on an SDK older than networkBodyMaxChars', () => {
  it('says the SDK caps bodies at 8192 and to update it, not to raise the option', async () => {
    const r = await judge('3.1.0', { bodyContains: 'not-in-the-prefix' });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain("This page's SDK 3.1.0 caps every recorded body at 8192");
    expect(r.inconclusive).toContain("Run `reticle update` in the app's folder");
    expect(r.inconclusive).toContain('restart its dev server');
    expect(r.inconclusive).not.toContain('networkBodyMaxChars: 65536');
  });

  it('keeps the bodyMatches remedy', async () => {
    const r = await judge('3.2.9', { bodyMatches: { status: 'ok' } });
    expect(r.inconclusive).toContain('caps every recorded body at 8192');
    expect(r.inconclusive).toContain('`bodyContains`');
  });
});

describe('a truncated body on an SDK that reads networkBodyMaxChars', () => {
  it.each(['3.3.0', '3.9.0'])('on %s, says how to raise the cap', async (sdk) => {
    const r = await judge(sdk, { bodyContains: 'not-in-the-prefix' });
    expect(r.inconclusive).toContain('networkBodyMaxChars: 65536');
    expect(r.inconclusive).not.toContain('reticle update');
  });

  it('treats an unknown SDK version as current', async () => {
    const r = await judge(undefined, { bodyContains: 'not-in-the-prefix' });
    expect(r.inconclusive).toContain('networkBodyMaxChars: 65536');
  });
});
