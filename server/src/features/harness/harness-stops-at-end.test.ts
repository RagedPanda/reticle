/**
 * A drive stops once a check has held and the page shows the end its goal quotes.
 *
 * Driven over MCP: the model reached "Generated script for", kept going, navigated to a start page
 * that signs the app out, and ended on a page without the result — a working journey failed by the
 * drive's own wandering.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool, Verified } from '@reticlehq/core';
import {
  FINISH_TOOL,
  runHarness,
  StopReason,
  type HarnessToolset,
  type ModelDriver,
} from './harness.js';

const END = 'Generated script for';

/** A model that never finishes: it presses Generate with a check, every turn, forever. */
const relentless: ModelDriver = {
  turn: () =>
    Promise.resolve({
      text: '',
      calls: [
        {
          id: 'c',
          name: ReticleTool.ACT_AND_WAIT,
          args: { ref: 'e1', action: 'click', until: { kind: 'net', method: 'POST' } },
        },
      ],
    }),
};

function page(showsEnd: () => boolean, verdict: string): HarnessToolset {
  return {
    tools: [],
    invoke: (name) => {
      if (ReticleTool.SNAPSHOT === name)
        return Promise.resolve({
          tree: showsEnd() ? `- text "${END}: notes"` : '- button "Generate"',
        });
      if (ReticleTool.SCROLL_TO === name) return Promise.resolve({ found: showsEnd() });
      return Promise.resolve({ verified: verdict });
    },
  };
}

const endsAt = { text: END, own: [`Press Generate and read "${END}".`] };

/**
 * A model that drives until the drive tells it the end is reached, then finishes with the verdict
 * its platform gives: on the broken checkout the platform holds the finish, asserts the order body
 * and answers `goalMet: false`. Before, the drive stopped here first and that check never ran.
 */
function finishesWhenTold(goalMet: boolean): ModelDriver {
  return {
    turn: ({ history }) => {
      const told = history.some((h) => 'user' === h.role && h.text.includes('Call `finish`'));
      return told
        ? Promise.resolve({
            text: '',
            calls: [{ id: 'f', name: FINISH_TOOL.name, args: { summary: 'done', goalMet } }],
          })
        : relentless.turn({ system: '', tools: [], history: [] });
    },
  };
}

describe('a drive whose goal quotes its end', () => {
  it('hands the finish to the model once the end shows, and keeps the verdict it gives', async () => {
    const broken = await runHarness(
      finishesWhenTold(false),
      page(() => true, Verified.YES),
      {
        maxSteps: 10,
        endsAt,
      },
    );
    expect(broken.stopReason).toBe(StopReason.FINISHED);
    expect(broken.goalMet).toBe(false);
    expect(broken.steps).toBe(2);
    const fixed = await runHarness(
      finishesWhenTold(true),
      page(() => true, Verified.YES),
      {
        maxSteps: 10,
        endsAt,
      },
    );
    expect(fixed.goalMet).toBe(true);
  });

  // From the live proof: a six-turn cap after the end cut the platform off while it held the
  // finish to assert the order body, and the drive ended before that check ran.
  it('never calls the goal met on its own when the model does not finish after the end', async () => {
    const drive = await runHarness(
      relentless,
      page(() => true, Verified.YES),
      {
        maxSteps: 12,
        endsAt,
      },
    );
    expect(drive.stopReason).toBe(StopReason.BUDGET);
    expect(drive.goalMet).not.toBe(true);
    expect(drive.steps).toBe(12);
  });

  it('keeps going while the end is not shown, and never stops on a check that failed', async () => {
    const hidden = await runHarness(
      relentless,
      page(() => false, Verified.YES),
      {
        maxSteps: 3,
        endsAt,
      },
    );
    expect(hidden.stopReason).toBe(StopReason.BUDGET);
    const failed = await runHarness(
      relentless,
      page(() => true, Verified.NO),
      {
        maxSteps: 3,
        endsAt,
      },
    );
    expect(failed.stopReason).toBe(StopReason.BUDGET);
  });
});
