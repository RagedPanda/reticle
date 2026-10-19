/**
 * The keep-alive, end to end on one machine: a Harness drive the agent started outlives the agent's
 * turn, and the Stop hook holds the turn until the drive ends, or until the 30-minute bound.
 *
 * The unit tests read hand-written drive records. Here the record is the one the real tool writes:
 * `reticle_verify {action:"explore", wait:0}` starts a drive that does not end, the call answers
 * `running` (the agent's turn may end now), and the real hook command (`handleReport`, what
 * `reticle report --hook` runs) is asked whether the agent may stop.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
// The tool table first, as the daemon loads it: the explore module sits on an import cycle with it.
import '@/surface/tools/tools.js';
import { answerExplore, type ExploreDrive } from '@/surface/tools/explore-tools.js';
import { DriveStatus, forgetDrives } from '@/features/harness/drive-runs.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { handleReport } from './report-command.js';

const MINUTE_MS = 60_000;

/** A drive that runs until the test ends it. */
function heldDrive(): { drive: ExploreDrive; end: () => void } {
  let end: () => void = () => undefined;
  const drive: ExploreDrive = () =>
    new Promise((resolve) => {
      end = () => resolve({ status: DriveStatus.DONE, result: { summary: 'drove checkout' } });
    });
  return { drive, end: () => end() };
}

function projectDeps(): { cwd: string; deps: ToolDeps } {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'keep-alive-')));
  const root = join(cwd, ReticleDir.ROOT);
  mkdirSync(root, { recursive: true });
  const deps = {
    reticleRoot: root,
    now: () => Date.now(),
    linkedCloud: () => Promise.resolve({ apiKey: 'rk_live_x', url: 'https://p.test' }),
    fs: createNodeFileSystem(),
  } as unknown as ToolDeps;
  return { cwd, deps };
}

/** The drive record the tool wrote, as the hook reads it. */
function record(cwd: string): Record<string, unknown> {
  const runs = join(cwd, ReticleDir.ROOT, ReticleDir.RUNS_SUBDIR);
  const file = readdirSync(runs).find((name) => name.endsWith('.drive.json'));
  if (file === undefined) throw new Error('no drive record');
  return JSON.parse(readFileSync(join(runs, file), 'utf8')) as Record<string, unknown>;
}

/** What the Stop hook prints, run in `cwd` as the agent's hook runs it. */
async function stopHook(cwd: string): Promise<string> {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const dir = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    await handleReport(undefined, true);
  } finally {
    write.mockRestore();
    dir.mockRestore();
  }
  return out;
}

afterEach(() => {
  forgetDrives();
  vi.useRealTimers();
});

describe('a Harness drive that outlives the agent’s turn', () => {
  it('holds the turn while it runs, and lets go when it ends', async () => {
    const { cwd, deps } = projectDeps();
    const held = heldDrive();
    const answer = (await answerExplore(deps, { wait: 0 }, undefined, held.drive)) as Record<
      string,
      unknown
    >;
    // The call answered while the drive runs: the agent is free to end its turn here.
    expect(answer['status']).toBe(DriveStatus.RUNNING);
    const runId = String(answer['runId']);
    await vi.waitFor(() => expect(record(cwd)['status']).toBe(DriveStatus.RUNNING));

    const blocked = JSON.parse(await stopHook(cwd)) as Record<string, unknown>;
    expect(blocked['decision']).toBe('block');
    expect(blocked['reason']).toContain(`reticle_verify {action:"explore", runId:"${runId}"}`);

    held.end();
    await vi.waitFor(() => expect(record(cwd)['status']).toBe(DriveStatus.DONE));
    expect(await stopHook(cwd)).not.toContain('"block"');
  });

  it('lets go after 30 minutes even when the drive never ends', async () => {
    const { cwd, deps } = projectDeps();
    const held = heldDrive();
    await answerExplore(deps, { wait: 0 }, undefined, held.drive);
    await vi.waitFor(() => expect(record(cwd)['status']).toBe(DriveStatus.RUNNING));
    const startedAt = Number(record(cwd)['startedAt']);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt + 29 * MINUTE_MS);
    expect(await stopHook(cwd)).toContain('"block"');
    vi.setSystemTime(startedAt + 30 * MINUTE_MS + 1);
    expect(await stopHook(cwd)).not.toContain('"block"');
    expect(record(cwd)['status']).toBe(DriveStatus.RUNNING);
  });
});
