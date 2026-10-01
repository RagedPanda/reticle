import { describe, expect, it, vi } from 'vitest';
import { chromiumLaunchOptions, CHROMIUM_ANTI_THROTTLING_ARGS } from './chromium-launch-options.js';

import { chromiumLaunchHint } from './portal/pool/playwright-launcher.js';
import { probeChromium, chromiumHint } from './command/cli/doctor/browser/chromium-hint.js';

vi.mock('playwright', () => ({ chromium: { executablePath: () => '/missing-bundled-chromium' } }));

describe('opt-in WebMCP browser configuration', () => {
  it('uses an explicitly selected executable and arguments without changing defaults', () => {
    const env = {
      RETICLE_WEBMCP_EXECUTABLE: '/test/chrome',
      RETICLE_WEBMCP_BROWSER_ARGS: '["--enable-features=WebMCPTesting"]',
    };
    expect(chromiumLaunchOptions(false, env)).toEqual({
      headless: false,
      executablePath: '/test/chrome',
      args: [...CHROMIUM_ANTI_THROTTLING_ARGS, '--enable-features=WebMCPTesting'],
    });
    expect(chromiumLaunchOptions(true, {})).toEqual({
      headless: true,
      args: [...CHROMIUM_ANTI_THROTTLING_ARGS],
    });
  });
  it('refuses malformed launch configuration instead of silently ignoring it', () => {
    expect(() =>
      chromiumLaunchOptions(true, { RETICLE_WEBMCP_BROWSER_ARGS: 'not-json' }),
    ).toThrow();
    expect(() => chromiumLaunchOptions(true, { RETICLE_WEBMCP_BROWSER_ARGS: '[3]' })).toThrow();
  });
  it('probes the configured executable even when bundled Chromium is absent', async () => {
    const result = await probeChromium({ RETICLE_WEBMCP_EXECUTABLE: process.execPath });
    expect(result).toMatchObject({
      executablePath: process.execPath,
      exists: true,
      configuredExecutable: true,
    });
    expect(chromiumHint(result)).toContain(process.execPath);
    expect(await probeChromium({})).toMatchObject({
      executablePath: '/missing-bundled-chromium',
      exists: false,
    });
  });
  it('directs a missing custom browser back to its configured path', async () => {
    const result = await probeChromium({ RETICLE_WEBMCP_EXECUTABLE: '/missing-custom-chrome' });
    expect(result).toMatchObject({ executablePath: '/missing-custom-chrome', exists: false });
    expect(chromiumHint(result)).toContain('RETICLE_WEBMCP_EXECUTABLE');
    expect(chromiumHint(result)).not.toContain('install chromium');
  });
  it('rejects an empty executable instead of falling back to bundled Chromium', () => {
    expect(() => chromiumLaunchOptions(true, { RETICLE_WEBMCP_EXECUTABLE: '' })).toThrow(
      /executable/i,
    );
  });
  it('preserves custom-browser launch errors instead of recommending a different browser', () => {
    const error = 'browserType.launch: Executable does not exist at /custom/chrome';
    expect(
      chromiumLaunchHint(error, { RETICLE_WEBMCP_EXECUTABLE: '/custom/chrome' }),
    ).toBeUndefined();
    expect(chromiumLaunchHint(error, {})).toContain('install chromium');
  });
});
