/**
 * Bare `reticle` in a folder that holds no app: find the dev servers that already run on this
 * computer and offer to verify one.
 *
 * A global install is often run from the home folder, not the app folder. The app is then running
 * on localhost all the same, and the person has to know a URL and a command to reach it. This
 * finds the URL for them.
 *
 * It reuses the no-session scan: the same port list (`DEV_SERVER_PORTS`) and the same probe
 * (`probeDevServerStates`). That list holds no Reticle port and no agent-tool port, so the scan
 * never asks them. Reticle's own ports are also removed from any list a caller passes.
 *
 * The framework name comes only from what the server answered to `GET /`. A port number is not
 * evidence, so a server that names nothing is "a web server".
 */
import { createInterface } from 'node:readline/promises';
import { RETICLE_VERIFY_DEFAULT_PORT } from '@/index.js';
import { DEV_SERVER_PORTS } from '@/command/cli/ports/resolve/cli-port.js';
import { WELL_KNOWN_RETICLE_PORTS } from '@/command/cli/ports/sibling-ports.js';
import { probeDevServerStates } from '@/portal/session/dev-server/dev-server-probe.js';

/** The most servers the list shows. More than this is a list nobody reads. */
export const MAX_OFFERED = 5;

/** The name for a server whose answer names no framework. */
export const UNKNOWN_SERVER = 'a web server';

const LOCALHOST = 'http://localhost';
const VERIFY_COMMAND = 'reticle verify';

/** The bridge, the bench daemon and the verify endpoint. None of them is an app. */
const RETICLE_PORTS: ReadonlySet<number> = new Set([
  ...WELL_KNOWN_RETICLE_PORTS,
  RETICLE_VERIFY_DEFAULT_PORT,
]);

/** A bound for the one `GET /` that names the framework. A slow answer names nothing. */
const ROOT_PAGE_TIMEOUT_MS = 1500;

/** Enough of the page to hold the markers. They are all in the document head or first scripts. */
const ROOT_PAGE_MAX_CHARS = 256 * 1024;

export interface RootPage {
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

/** The two network reads, injected so a test opens no socket. */
export interface DevServerScan {
  /** Which of these ports serve a document now. */
  serving: (ports: readonly number[]) => Promise<readonly number[]>;
  /** The answer to `GET /` at `url`, or undefined when there is no answer in time. */
  rootPage: (url: string) => Promise<RootPage | undefined>;
}

export interface RunningDevServer {
  url: string;
  /** The framework the server's answer named, or undefined when it named none. */
  framework: string | undefined;
}

interface Marker {
  framework: string;
  poweredBy?: RegExp;
  body?: readonly string[];
}

/**
 * Checked in order. A framework that runs on Vite comes before Vite, because its page carries the
 * Vite client too.
 */
const MARKERS: readonly Marker[] = [
  { framework: 'Next.js', poweredBy: /next\.js/i, body: ['__NEXT_DATA__', '/_next/'] },
  { framework: 'Nuxt', poweredBy: /nuxt/i, body: ['__NUXT__', '/_nuxt/'] },
  { framework: 'SvelteKit', body: ['__sveltekit'] },
  { framework: 'Astro', body: ['astro-dev-toolbar', 'content="Astro'] },
  { framework: 'React Router', body: ['__reactRouterContext', '__remixContext'] },
  { framework: 'Vite', body: ['/@vite/client'] },
];

/** The framework a root page names, or undefined. */
export function frameworkOf(page: RootPage | undefined): string | undefined {
  if (page === undefined) {
    return undefined;
  }
  const poweredBy = page.headers['x-powered-by'] ?? '';
  const match = MARKERS.find(
    (marker) =>
      (marker.poweredBy?.test(poweredBy) ?? false) ||
      (marker.body ?? []).some((text) => page.body.includes(text)),
  );
  return match?.framework;
}

/** The dev servers that answer now, lowest port first, at most {@link MAX_OFFERED}. */
export async function findRunningDevServers(
  scan: DevServerScan,
  candidates: readonly number[] = [...DEV_SERVER_PORTS],
): Promise<RunningDevServer[]> {
  const ports = candidates.filter((port) => !RETICLE_PORTS.has(port));
  const serving = [...(await scan.serving(ports))].sort((a, b) => a - b).slice(0, MAX_OFFERED);
  return Promise.all(
    serving.map(async (port) => {
      const url = `${LOCALHOST}:${String(port)}`;
      const page = await scan.rootPage(url).catch(() => undefined);
      return { url, framework: frameworkOf(page) };
    }),
  );
}

async function fetchRootPage(url: string): Promise<RootPage | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(ROOT_PAGE_TIMEOUT_MS) });
    const body = (await response.text()).slice(0, ROOT_PAGE_MAX_CHARS);
    return { headers: { 'x-powered-by': response.headers.get('x-powered-by') ?? undefined }, body };
  } catch {
    return undefined;
  }
}

/** The real network reads. */
export const nodeDevServerScan: DevServerScan = {
  serving: async (ports) => (await probeDevServerStates(ports)).serving,
  rootPage: fetchRootPage,
};

export interface OfferIo {
  /** stdin and stdout are a terminal, so a person can answer. */
  interactive: boolean;
  /** `--json`: print the list as JSON and never ask. */
  json: boolean;
  write: (text: string) => void;
  ask: (question: string) => Promise<string>;
}

/** One line from the person at the terminal. */
export async function askInTerminal(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

const commandFor = (url: string): string => `${VERIFY_COMMAND} ${url}`;
const labelOf = (server: RunningDevServer): string =>
  `${server.url} (${server.framework ?? UNKNOWN_SERVER})`;

/** The server the answer chose, or undefined for Enter or an answer that names none. */
function chosen(
  answer: string,
  servers: readonly RunningDevServer[],
): RunningDevServer | undefined {
  const text = answer.trim().toLowerCase();
  if (1 === servers.length && ('y' === text || 'yes' === text)) {
    return servers[0];
  }
  const index = Number(text);
  if (!Number.isInteger(index) || index < 1) {
    return undefined;
  }
  return servers[index - 1];
}

/**
 * Show what was found. In a terminal, ask which one to verify and return its URL. Otherwise print
 * the command for each one and return undefined. With nothing found, write nothing.
 */
export async function offerRunningDevServers(
  servers: readonly RunningDevServer[],
  io: OfferIo,
): Promise<string | undefined> {
  if (0 === servers.length) {
    return undefined;
  }
  if (io.json) {
    const devServers = servers.map((server) => ({
      url: server.url,
      framework: server.framework ?? null,
      command: commandFor(server.url),
    }));
    io.write(`${JSON.stringify({ devServers })}\n`);
    return undefined;
  }
  if (!io.interactive) {
    const lines = servers.map((server) => `  ${labelOf(server)}: ${commandFor(server.url)}`);
    io.write(
      `Reticle found ${String(servers.length)} running app(s) on this computer. ` +
        `To verify one, run its command:\n${lines.join('\n')}\n`,
    );
    return undefined;
  }
  const [only] = servers;
  if (only !== undefined && 1 === servers.length) {
    io.write(`Reticle found ${labelOf(only)}.\n`);
    return chosen(await io.ask('Verify it now? [y/N] '), servers)?.url;
  }
  const lines = servers.map((server, i) => `  ${String(i + 1)}. ${labelOf(server)}`);
  io.write(`Reticle found ${String(servers.length)} running apps:\n${lines.join('\n')}\n`);
  const range = `1-${String(servers.length)}`;
  return chosen(await io.ask(`Verify which one? Type ${range}, or press Enter to skip: `), servers)
    ?.url;
}
