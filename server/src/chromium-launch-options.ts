/**
 * The launch options every Reticle-driven Chromium gets, in one place.
 *
 * A pooled browser serves several lease contexts while only one page is ever the visible one, and a
 * driven page can sit in a window the host does not treat as visible. For everyone else Chromium
 * throttles timers, suspends rAF, and deprioritizes the renderer, which is exactly the state a
 * session reports as `throttled: true`: WebSocket- and timer-driven DOM updates land seconds late,
 * asserts time out on content that appears right after the timeout, with no refetch, because the
 * app was fine and the browser was parked. The three switches below are the documented opt-outs,
 * shared by both launch sites so the pooled path (`playwright-launcher`) and the drive path
 * (`real-input`) cannot drift apart.
 */

/**
 * Chromium switches that keep background pages running at full speed. Named individually rather
 * than as one free string per call site, so a typo is a test failure instead of a silently ignored
 * argument.
 */
export const CHROMIUM_ANTI_THROTTLING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

/** The options object handed to `chromium.launch` at both launch sites. */
interface ChromiumLaunchOptions {
  headless: boolean;
  args: string[];
  executablePath?: string;
}

export const WEBMCP_BROWSER_ENV = {
  EXECUTABLE: 'RETICLE_WEBMCP_EXECUTABLE',
  ARGS: 'RETICLE_WEBMCP_BROWSER_ARGS',
} as const;

/** Shared by launch and preflight so a selected browser cannot be rejected for a missing bundle. */
export function chromiumExecutablePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const path = env[WEBMCP_BROWSER_ENV.EXECUTABLE];
  if (path !== undefined && 0 === path.trim().length) {
    throw new Error(`${WEBMCP_BROWSER_ENV.EXECUTABLE} must name a browser executable`);
  }
  return path;
}

/** Explicit experimental configuration; no browser flag or input format is guessed. */
export function chromiumLaunchOptions(
  headless: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChromiumLaunchOptions {
  const raw = env[WEBMCP_BROWSER_ENV.ARGS];
  const extra: unknown = raw === undefined ? [] : JSON.parse(raw);
  if (
    !Array.isArray(extra) ||
    extra.length > 20 ||
    !extra.every((v: unknown) => 'string' === typeof v && v.startsWith('--') && v.length <= 2048)
  ) {
    throw new Error(`${WEBMCP_BROWSER_ENV.ARGS} must be a JSON array of browser switches`);
  }
  const executablePath = chromiumExecutablePath(env);
  return {
    headless,
    args: [...CHROMIUM_ANTI_THROTTLING_ARGS, ...(extra as string[])],
    ...(executablePath === undefined ? {} : { executablePath }),
  };
}
