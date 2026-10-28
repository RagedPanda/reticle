import { describe, expect, it } from 'vitest';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import {
  MAX_OFFERED,
  findRunningDevServers,
  frameworkOf,
  offerRunningDevServers,
  type DevServerScan,
  type OfferIo,
  type RootPage,
  type RunningDevServer,
} from './running-dev-servers.js';
import { RETICLE_BENCH_PORT } from './ports/sibling-ports.js';

/** A scan over fake ports: no socket opens in this file. */
function scanOf(serving: readonly number[], pages: Record<string, RootPage> = {}): DevServerScan {
  return {
    serving: (ports) => Promise.resolve(ports.filter((port) => serving.includes(port))),
    rootPage: (url) => Promise.resolve(pages[url]),
  };
}

const page = (body: string, headers: Record<string, string> = {}): RootPage => ({ headers, body });

function recordingIo(over: Partial<OfferIo> & { answer?: string } = {}): OfferIo & {
  out: string[];
  asked: string[];
} {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    interactive: false,
    json: false,
    write: (text) => out.push(text),
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(over.answer ?? '');
    },
    ...over,
    out,
    asked,
  };
}

const NEXT: RunningDevServer = { url: 'http://localhost:3000', framework: 'Next.js' };
const OTHER: RunningDevServer = { url: 'http://localhost:8080', framework: undefined };

describe('findRunningDevServers', () => {
  it('excludes Reticle ports even when the candidate list names them', async () => {
    const found = await findRunningDevServers(
      scanOf([3000, RETICLE_DEFAULT_PORT, RETICLE_BENCH_PORT]),
      [3000, RETICLE_DEFAULT_PORT, RETICLE_BENCH_PORT],
    );
    expect(found.map((s) => s.url)).toEqual(['http://localhost:3000']);
  });

  it('never asks a port outside the dev-server list, so agent-tool ports are not offered', async () => {
    const asked: number[] = [];
    await findRunningDevServers({
      serving: (ports) => {
        asked.push(...ports);
        return Promise.resolve([]);
      },
      rootPage: () => Promise.resolve(undefined),
    });
    expect(asked).toContain(3000);
    expect(asked).not.toContain(RETICLE_DEFAULT_PORT);
    expect(asked).not.toContain(6274);
  });

  it('offers at most five', async () => {
    const ports = [3000, 3001, 4200, 5173, 5174, 8000, 8080];
    const found = await findRunningDevServers(scanOf(ports), ports);
    expect(found).toHaveLength(MAX_OFFERED);
  });

  it('names the framework only from what the server answered', async () => {
    const found = await findRunningDevServers(
      scanOf([3000, 5173, 8080], {
        'http://localhost:3000': page('<script id="__NEXT_DATA__">'),
        'http://localhost:5173': page('<script type="module" src="/@vite/client">'),
        'http://localhost:8080': page('<html>hello</html>'),
      }),
      [3000, 5173, 8080],
    );
    expect(found).toEqual([
      { url: 'http://localhost:3000', framework: 'Next.js' },
      { url: 'http://localhost:5173', framework: 'Vite' },
      { url: 'http://localhost:8080', framework: undefined },
    ]);
  });
});

describe('frameworkOf', () => {
  it('reads x-powered-by', () => {
    expect(frameworkOf(page('', { 'x-powered-by': 'Next.js' }))).toBe('Next.js');
  });
  it('prefers the framework over the Vite it runs on', () => {
    expect(frameworkOf(page('/@vite/client window.__NUXT__'))).toBe('Nuxt');
    expect(frameworkOf(page('/@vite/client __sveltekit_abc'))).toBe('SvelteKit');
  });
  it('does not guess from the port: no answer is no name', () => {
    expect(frameworkOf(undefined)).toBeUndefined();
    expect(frameworkOf(page('<html></html>', { 'x-powered-by': 'Express' }))).toBeUndefined();
  });
});

describe('offerRunningDevServers', () => {
  it('found nothing: writes nothing and asks nothing', async () => {
    const io = recordingIo({ interactive: true });
    expect(await offerRunningDevServers([], io)).toBeUndefined();
    expect(io.out).toEqual([]);
    expect(io.asked).toEqual([]);
  });

  it('in a terminal, asks once and returns the chosen URL', async () => {
    const io = recordingIo({ interactive: true, answer: 'y' });
    expect(await offerRunningDevServers([NEXT], io)).toBe(NEXT.url);
    expect(io.out.join('')).toContain('http://localhost:3000 (Next.js)');
    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toContain('Verify it now?');
  });

  it('in a terminal with several, takes a number and names an unknown server plainly', async () => {
    const io = recordingIo({ interactive: true, answer: '2' });
    expect(await offerRunningDevServers([NEXT, OTHER], io)).toBe(OTHER.url);
    expect(io.out.join('')).toContain('http://localhost:8080 (a web server)');
  });

  it('in a terminal, Enter or a bad answer verifies nothing', async () => {
    expect(
      await offerRunningDevServers([NEXT], recordingIo({ interactive: true, answer: '' })),
    ).toBeUndefined();
    expect(
      await offerRunningDevServers([NEXT, OTHER], recordingIo({ interactive: true, answer: '9' })),
    ).toBeUndefined();
  });

  it('with no terminal, prints each command and never asks', async () => {
    const io = recordingIo({ interactive: false });
    expect(await offerRunningDevServers([NEXT, OTHER], io)).toBeUndefined();
    expect(io.asked).toEqual([]);
    const text = io.out.join('');
    expect(text).toContain('reticle verify http://localhost:3000');
    expect(text).toContain('reticle verify http://localhost:8080');
  });

  it('with --json, prints the list as JSON and never asks, even in a terminal', async () => {
    const io = recordingIo({ interactive: true, json: true });
    expect(await offerRunningDevServers([NEXT], io)).toBeUndefined();
    expect(io.asked).toEqual([]);
    expect(JSON.parse(io.out.join(''))).toEqual({
      devServers: [
        {
          url: 'http://localhost:3000',
          framework: 'Next.js',
          command: 'reticle verify http://localhost:3000',
        },
      ],
    });
  });
});
