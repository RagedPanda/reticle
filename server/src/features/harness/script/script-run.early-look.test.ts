/**
 * A model drive's own early look at the end it is driving towards is not a failed check.
 *
 * Driven over MCP: the model asserted "Generated script for" before the request that writes it had
 * answered, read `no`, and the journey failed — while the Harness's end check, a moment later, held.
 * The drive's failures are judged after its end, under the same supersede rule as the run's verdict.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool, ScriptStatus, Verified } from '@reticlehq/core';
import { DriveScriptSchema } from '@reticlehq/core/artifacts';
import { runScript, type ScriptPorts } from './script-run.js';
import { StopReason, type HarnessResult, type ToolOutcome } from '../harness.js';

const END = 'Generated script for';

const assertEnd = (verified: string): ToolOutcome => ({
  id: 'a',
  name: ReticleTool.ASSERT,
  args: { predicate: { kind: 'text', contains: END } },
  result: { verified },
  isError: false,
});

const declaredMiss: ToolOutcome = {
  id: 'd',
  name: ReticleTool.ACT_AND_WAIT,
  args: { ref: 'e1', action: 'click', until: { kind: 'signal', name: 'saved' } },
  result: { verified: Verified.NO },
  isError: false,
};

function ports(driveCalls: ToolOutcome[]): ScriptPorts {
  let driven = false;
  return {
    parallel: 1,
    stopped: () => false,
    lease: () => Promise.resolve({ release: () => Promise.resolve() }),
    toolset: () => ({
      tools: [],
      invoke(name) {
        if (ReticleTool.SNAPSHOT === name)
          {return Promise.resolve({
            tree: driven ? `- paragraph "${END}: notes"` : '- button "Generate" (ref=e1)',
            status: { route: '/compose' },
          });}
        return Promise.resolve({ pass: driven, verified: driven ? Verified.YES : Verified.NO });
      },
    }),
    drive(): Promise<HarnessResult> {
      driven = true;
      return Promise.resolve({
        stopReason: StopReason.FINISHED,
        summary: '',
        steps: 4,
        toolCalls: driveCalls,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        proved: true,
      });
    },
  };
}

const script = DriveScriptSchema.parse({
  version: 1,
  source: 'platform',
  journeys: [
    {
      id: 'j1',
      title: 'Compose',
      steps: [{ kind: 'act', goal: `Press Generate and read "${END}".` }],
    },
  ],
  lanes: [{ id: 'A', journeys: ['j1'] }],
});

const statusOf = async (calls: ToolOutcome[]): Promise<string | undefined> =>
  (await runScript(script, ports(calls))).view.lanes[0]?.journeys[0]?.status;

describe("a model drive's early look at its end", () => {
  it('passes when the end then holds', async () => {
    expect(await statusOf([assertEnd(Verified.NO)])).toBe(ScriptStatus.PASSED);
  });

  it('still fails beside a declared check that failed', async () => {
    expect(await statusOf([declaredMiss, assertEnd(Verified.NO)])).toBe(ScriptStatus.FAILED);
  });
});
