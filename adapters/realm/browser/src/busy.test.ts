/** Work the app declares is announced as it starts and as it ends, whether it resolves or rejects. */
import { describe, expect, it } from 'vitest';
import { RETICLE_BUSY_SIGNAL } from '@reticlehq/core';
import { trackBusy } from './busy.js';

describe('trackBusy', () => {
  it('signals a start, then an end when the work settles either way, and hands the work back', async () => {
    const sent: unknown[] = [];
    const signal = (name: string, data: Record<string, unknown>): void => {
      sent.push([name, data]);
    };
    expect(await trackBusy(Promise.resolve(7), signal)).toBe(7);
    await expect(trackBusy(Promise.reject(new Error('no')), signal)).rejects.toThrow('no');
    expect(sent).toEqual([
      [RETICLE_BUSY_SIGNAL, { delta: 1 }],
      [RETICLE_BUSY_SIGNAL, { delta: -1 }],
      [RETICLE_BUSY_SIGNAL, { delta: 1 }],
      [RETICLE_BUSY_SIGNAL, { delta: -1 }],
    ]);
  });
});
