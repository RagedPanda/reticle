import { RETICLE_BUSY_SIGNAL } from '@reticlehq/core';

/**
 * Work only the app can see (a debounced save, a worker, a socket reply), announced as it starts and
 * ends so a wait for the page to settle holds until it is done (`settled` counts it like a request).
 * Returns `work` untouched: the caller still owns its result and its rejection.
 */
export function trackBusy<T>(
  work: Promise<T>,
  signal: (name: string, data: Record<string, unknown>) => void,
): Promise<T> {
  signal(RETICLE_BUSY_SIGNAL, { delta: 1 });
  const done = (): void => {
    signal(RETICLE_BUSY_SIGNAL, { delta: -1 });
  };
  work.then(done, done);
  return work;
}
