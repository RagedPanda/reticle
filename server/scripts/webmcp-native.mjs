// Native qualification is deliberately separate from mock tests: missing APIs FAIL this command.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  start,
  createMcpServer,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '../dist/index.js';
import { TOOL_SURFACE } from '../dist/surface/tools/tool-surface.js';
import { chromiumLaunchOptions } from '../dist/chromium-launch-options.js';
import { zeroInstallScript } from '../dist/portal/pool/zero-install.js';
import { BrowserPool } from '../dist/portal/pool/browser-pool.js';
import { playwrightLauncher } from '../dist/portal/pool/playwright-launcher.js';
import { probeChromium } from '../dist/command/cli/doctor/browser/chromium-hint.js';
import { bridgeWsUrl } from '@reticlehq/core';

process.env.RETICLE_TELEMETRY = '0';
const html = await readFile(new URL('../../apps/e2e/webmcp/fixture.html', import.meta.url), 'utf8');
const bundle = await readFile(
  createRequire(import.meta.url).resolve('@reticlehq/browser/inject'),
  'utf8',
);
const root = await mkdtemp(join(tmpdir(), 'reticle-webmcp-'));
let writes = 0;
const app = createServer((request, response) => {
  if (
    request.url === '/authenticated' &&
    !request.headers.cookie?.includes('fixture-auth=allowed')
  ) {
    response.writeHead(401, { 'content-type': 'text/html' });
    response.end('<h1>Authentication required</h1>');
    return;
  }
  if (request.url === '/reject-cart') {
    request.resume();
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fixture rejected write' }));
    return;
  }
  if (request.url === '/cart' && request.method === 'POST') {
    request.resume();
    writes++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ count: writes }));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  }
});
let running, browser, client, mcp, pool;
const bridgePort = Number(process.env.RETICLE_WEBMCP_PORT ?? '4419');
const report = {
  status: 'incomplete',
  phase: 'configuration',
  node: process.version,
  playwright: createRequire(import.meta.url)('playwright/package.json').version,
  checks: [],
};
try {
  const launch = chromiumLaunchOptions(process.env.RETICLE_WEBMCP_HEADED !== '1');
  Object.assign(report, {
    headless: launch.headless,
    args: launch.args,
    inputEncoding: process.env.RETICLE_WEBMCP_INPUT_ENCODING ?? 'object',
  });
  assert(['object', 'json'].includes(report.inputEncoding), 'unknown WebMCP input encoding');
  report.phase = 'fixture-start';
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  const address = app.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  running = await start({
    port: bridgePort,
    mcp: false,
    reticleRoot: join(root, '.reticle'),
    pairingTokenDir: root,
  });
  report.phase = 'browser-launch';
  browser = await chromium.launch(launch);
  report.browser = browser.version();
  report.phase = 'native-api';
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(() => window.fixtureReady);
  assert.equal(
    await page.evaluate(() => !!window.__reticleInstance),
    false,
    'fixture must start without Reticle',
  );
  // Use precisely the reader script that the lease path supplies to sites with no SDK.
  await page.evaluate(
    zeroInstallScript(bundle, { url: bridgeWsUrl(bridgePort), token: running.token }),
  );
  const deadline = Date.now() + 10_000;
  while (running.bridge.sessions.list().length === 0 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  let sessionId = running.bridge.sessions.list()[0]?.sessionId;
  assert(sessionId, 'injected reader did not connect');
  pool = new BrowserPool(playwrightLauncher({ headless: launch.headless }), {
    maxContexts: 1,
    genSessionId: () => `webmcp-${randomUUID()}`,
    zeroInstallScript: () =>
      zeroInstallScript(bundle, { url: bridgeWsUrl(bridgePort), token: running.token }),
  });
  const fs = createNodeFileSystem();
  const deps = {
    sessions: running.bridge.sessions,
    pool,
    browserProbe: probeChromium,
    bridgePort,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, root, { now: Date.now }),
    project: new ProjectStore(fs, root, { now: Date.now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: join(root, '.reticle'),
    now: Date.now,
  };
  mcp = createMcpServer(deps, TOOL_SURFACE.ALL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  client = new Client({ name: 'webmcp-native-qualification', version: '1' });
  await client.connect(clientTransport);
  const call = async (name, args, scoped = true) => {
    const result = await client.callTool({
      name,
      arguments: { ...(scoped ? { sessionId } : {}), ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert(result.structuredContent, 'full MCP surface must retain structured results');
    return result.structuredContent;
  };
  report.phase = 'discovery';
  const catalog = await call('reticle_webmcp', {});
  assert.equal(catalog.status, 'available');
  for (const name of ['addToCart', 'pretendToAdd', 'addWithForm'])
    assert(
      catalog.tools.some((t) => t.name === name),
      `missing native tool ${name}`,
    );
  const inputEncoding = process.env.RETICLE_WEBMCP_INPUT_ENCODING ?? 'object';
  const invoke = async (tool) => {
    const detail = await call('reticle_webmcp', { tool });
    return call('reticle_act_and_wait', {
      action: 'webmcp',
      args: { toolId: detail.tools[0].toolId, params: { sku: 'fixture' }, inputEncoding },
      until: { kind: 'net', method: 'POST', urlContains: '/cart', status: 200 },
      timeout_ms: 1500,
    });
  };
  report.phase = 'imperative-effect';
  assert.equal((await invoke('addToCart')).verified, 'yes', 'honest effect must be proved');
  assert.equal(writes, 1, 'imperative tool must execute once');
  report.checks.push('imperative-effect');
  report.phase = 'negative-control';
  assert.equal(
    (await invoke('pretendToAdd')).verified,
    'no',
    'negative control must fail with complete capture',
  );
  assert.equal(writes, 1, 'negative control must not write');
  report.checks.push('negative-control');
  report.phase = 'declarative-effect';
  assert.equal(
    (await invoke('addWithForm')).verified,
    'yes',
    'native declarative form must be proved',
  );
  assert.equal(writes, 2, 'declarative tool must submit once');
  report.checks.push('declarative-effect');
  report.phase = 'cached-read';
  const read = await call('reticle_act', {
    action: 'webmcp',
    args: { tool: 'readCart', inputEncoding },
  });
  assert.equal(read.inputMode, 'webmcp');
  assert.equal(writes, 2, 'cached read must not dispatch a write');
  report.checks.push('cached-read');
  report.phase = 'rejected-backend';
  assert.equal(
    (await invoke('rejectCart')).verified,
    'no',
    'a self-report cannot overrule the rejected write',
  );
  assert.equal(writes, 2);
  report.checks.push('rejected-backend');
  report.phase = 'registration-lifecycle';
  await page.evaluate(async () => {
    window.fixtureToolController = new AbortController();
    await document.modelContext.registerTool(
      {
        name: 'lateSearch',
        description: 'Registered after injection',
        inputSchema: { type: 'object' },
        execute: () => ({ ok: true }),
      },
      { signal: window.fixtureToolController.signal },
    );
  });
  const late = await call('reticle_webmcp', { tool: 'lateSearch' });
  await page.evaluate(() => window.fixtureToolController.abort());
  const stale = await client.callTool({
    name: 'reticle_act',
    arguments: {
      sessionId,
      action: 'webmcp',
      args: { toolId: late.tools[0].toolId, inputEncoding },
    },
  });
  assert.equal(stale.isError, true, 'removed native registration must refuse the old handle');
  assert.equal(writes, 2);
  report.checks.push('registration-lifecycle');

  // Exercise the public lease path, including its browser preflight, cookie seeding, and injection.
  report.phase = 'authenticated-lease';
  const unauthenticated = await fetch(`${url}/authenticated`);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  const priorToolId = catalog.tools.find((t) => t.name === 'addToCart').toolId;
  await browser.close();
  browser = undefined;
  const lease = await call(
    'reticle_lease',
    {
      action: 'acquire',
      url: `${url}/authenticated`,
      seedStorage: { cookies: { 'fixture-auth': 'allowed' } },
    },
    false,
  );
  assert.equal(lease.ready, true, 'public lease must attach to the authenticated website');
  assert.equal(lease.zeroInstall, true, 'public lease must inject the reader');
  sessionId = lease.sessionId;
  const leaseCatalog = await call('reticle_webmcp', {});
  assert.equal(leaseCatalog.status, 'available');
  const previousDocument = await client.callTool({
    name: 'reticle_act',
    arguments: {
      sessionId,
      action: 'webmcp',
      args: { toolId: priorToolId, params: { sku: 'fixture' }, inputEncoding },
    },
  });
  assert.equal(
    previousDocument.isError,
    true,
    'a handle from the earlier document must not dispatch',
  );
  assert.equal(writes, 2);
  assert.equal(
    (await invoke('addToCart')).verified,
    'yes',
    'authenticated lease must observe the tool effect',
  );
  assert.equal(writes, 3, 'leased tool must execute once');
  report.checks.push('authenticated-lease', 'previous-document-refusal');
  await call('reticle_lease', { action: 'release', sessionId });

  report.status = 'passed';
  report.phase = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  // Attempt every teardown before writing artifacts; a failed artifact path cannot orphan a browser.
  const cleanup = await Promise.allSettled([
    client?.close(),
    mcp?.close(),
    browser?.close(),
    pool?.shutdown(),
    running?.close(),
  ]);
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await rm(root, { recursive: true, force: true });
  const cleanupFailed = cleanup.some((result) => result.status === 'rejected');
  const otherwisePassed = report.status === 'passed';
  if (cleanupFailed) {
    report.status = 'failed';
    report.cleanupFailed = true;
  }
  const reportJson = JSON.stringify(report, null, 2);
  console.log(reportJson);
  const reportPath = process.env.RETICLE_WEBMCP_REPORT;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${reportJson}\n`);
  }
  if (cleanupFailed && otherwisePassed) throw new Error('Native qualification teardown failed');
}
