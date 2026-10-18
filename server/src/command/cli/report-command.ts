/**
 * `reticle report [--session <id>] [--hook]` — what this project's latest session claimed, and what held.
 *
 * Read from disk, with no daemon: the journal is on disk, and a Stop hook has to answer in the second
 * after the agent stops, when there may be nothing running to ask. The fold is `gapSummary`, the same
 * one `reticle_context` serves, so the terminal and the agent cannot be told two different stories.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DiscoveryInvite, ReticleDir, asRecord } from '@reticlehq/core';
import { gapSummary } from '@/judgement/runs/artifact/gap-summary.js';
import { SessionJournal } from '@/memory/journal/session-journal.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { gapHookLine, gapReportLines } from '@/judgement/runs/artifact/gap-report.js';
import { DriveOrigin, DriveStatus, pollCall } from '@/features/harness/drive-runs.js';
import { DRIVE_RECORD_SUFFIX, UNMATCHED_SUBDIR } from '@/memory/project/dir/reticle-dir.js';

/**
 * A session last written longer ago than this is not the turn a hook is asking about.
 *
 * ponytail: a fixed window, not a turn boundary — the Stop hook is not told when the turn began. A
 * drive older than an hour reads as "no claim this session", which errs toward saying so.
 */
const HOOK_WINDOW_MS = 60 * 60 * 1000;

/**
 * How long the Stop hook keeps an agent for one Harness drive. A record still `running` after this
 * was left by a daemon that stopped, and it would hold the agent forever.
 *
 * ponytail: a fixed bound from the start time, not a liveness check on the daemon. Ask the daemon
 * when a real drive runs longer than this.
 */
const KEEP_ALIVE_MAX_MS = 30 * 60 * 1000;

/** What the Stop hook tells an agent that tried to stop while its Harness drive runs. */
export function keepAliveReason(runId: string): string {
  return (
    `The Harness drive ${runId} that you started is still running. Do not stop yet. ` +
    `Call ${pollCall(runId)} until it ends. If it reports a failed check, fix the code, then ` +
    `start the same drive again to verify the fix.`
  );
}

/** The newest drive this agent started that still runs, read from `.reticle/runs/`. */
function agentDriveRunning(root: string, now: number): string | undefined {
  const runs = join(root, ReticleDir.RUNS_SUBDIR);
  if (!existsSync(runs)) return undefined;
  let newest: { runId: string; startedAt: number } | undefined;
  for (const name of readdirSync(runs)) {
    if (!name.endsWith(DRIVE_RECORD_SUFFIX)) continue;
    let record: Record<string, unknown>;
    try {
      record = asRecord(JSON.parse(readFileSync(join(runs, name), 'utf8')));
    } catch {
      continue;
    }
    const { harnessRun, status, origin, startedAt } = record;
    if (DriveStatus.RUNNING !== status || DriveOrigin.AGENT !== origin) continue;
    if ('string' !== typeof harnessRun || 'number' !== typeof startedAt) continue;
    if (now - startedAt > KEEP_ALIVE_MAX_MS) continue;
    if (newest === undefined || startedAt > newest.startedAt)
      newest = { runId: harnessRun, startedAt };
  }
  return newest?.runId;
}

export interface ReportInput {
  cwd: string;
  now: number;
  /** Did the working tree change? The hook stays silent on a turn that edited nothing. */
  treeChanged: boolean;
  session?: string;
  hook?: boolean;
  /** The user's home, whose `~/.reticle/unmatched` is read too. Absent: the project's root alone. */
  home?: string;
}

interface Found {
  id: string;
  writtenAt: number;
  root: string;
}

/**
 * Every `.reticle` root a session of this project can be in: the project's own, then each folder the
 * daemon filed under `~/.reticle/unmatched` for a page it could not tie to a project (before
 * `reticle init`). Without them the hook said "No claim was checked" after claims had held.
 *
 * ponytail: an unmatched folder is not tied to this cwd; the newest session in the window wins.
 */
function sessionRoots(root: string, home: string | undefined): string[] {
  if (home === undefined) return [root];
  const unmatched = join(home, ReticleDir.ROOT, UNMATCHED_SUBDIR);
  if (!existsSync(unmatched)) return [root];
  return [root, ...readdirSync(unmatched).map((name) => join(unmatched, name))];
}

/** The session whose action ledger was written most recently, if any. */
function newestSession(roots: readonly string[]): Found | undefined {
  let newest: Found | undefined;
  for (const root of roots) {
    const sessionsDir = join(root, ReticleDir.SESSIONS_SUBDIR);
    if (!existsSync(sessionsDir)) continue;
    for (const id of readdirSync(sessionsDir)) {
      const ledger = join(sessionsDir, id, ReticleDir.JOURNAL_ACTIONS_FILE);
      if (!existsSync(ledger)) continue;
      const writtenAt = statSync(ledger).mtimeMs;
      if (newest === undefined || writtenAt > newest.writtenAt) newest = { id, writtenAt, root };
    }
  }
  return newest;
}

export async function reportFor(input: ReportInput): Promise<{ lines: string[]; block?: string }> {
  const root = join(input.cwd, ReticleDir.ROOT);
  // The one case the hook blocks: the agent's own Harness drive is still running, so its result,
  // and any defect it finds, would reach nobody.
  const driving = true === input.hook ? agentDriveRunning(root, input.now) : undefined;
  if (driving !== undefined) return { lines: [], block: keepAliveReason(driving) };
  if (true === input.hook && !input.treeChanged) return { lines: [] };
  const found =
    input.session === undefined
      ? newestSession(sessionRoots(root, input.home))
      : { id: input.session, writtenAt: input.now, root };
  const current =
    found !== undefined && (true !== input.hook || input.now - found.writtenAt <= HOOK_WINDOW_MS)
      ? found
      : undefined;
  const actions =
    current === undefined
      ? []
      : await new SessionJournal(createNodeFileSystem(), current.root, current.id).readActions();
  const gap = gapSummary(actions);
  if (true === input.hook) {
    const line = gapHookLine(gap);
    // A finish with nothing proved is the moment Reticle let somebody down: say who to tell.
    return { lines: line === undefined ? [] : [line, DiscoveryInvite.HUMAN] };
  }
  const header = current === undefined ? [] : [`session ${current.id}`];
  return { lines: [...header, ...gapReportLines(gap), DiscoveryInvite.HUMAN] };
}

/** Uncommitted changes in `cwd`. Outside a git repository nothing can say, so it answers yes. */
function treeChanged(cwd: string): boolean {
  try {
    return '' !== execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return true;
  }
}

/**
 * The command. As a hook it prints Claude Code's `systemMessage` shape and always exits 0, so the
 * human sees the gap. It blocks the stop in one case only: a Harness drive the agent started is still
 * running, bounded by `KEEP_ALIVE_MAX_MS`.
 */
export async function handleReport(session: string | undefined, hook: boolean): Promise<void> {
  const cwd = process.cwd();
  let lines: string[];
  let block: string | undefined;
  try {
    ({ lines, block } = await reportFor({
      cwd,
      now: Date.now(),
      home: homedir(),
      treeChanged: hook ? treeChanged(cwd) : true,
      ...(session === undefined ? {} : { session }),
      hook,
    }));
  } catch (error) {
    // A hook that throws turns the agent's stop into an error the user did not cause; it says nothing
    // instead. Run by hand, the reason is the answer (an id that is not a session, a journal it
    // could not read), so it is printed and the exit is non-zero.
    if (hook) return;
    process.stderr.write(
      `reticle report: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // Claude Code and Codex both read this shape from a Stop hook: the agent goes on, told `reason`.
  if (block !== undefined) {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: block })}\n`);
    return;
  }
  if (0 === lines.length) return;
  process.stdout.write(
    hook ? `${JSON.stringify({ systemMessage: lines.join('\n') })}\n` : `${lines.join('\n')}\n`,
  );
}
