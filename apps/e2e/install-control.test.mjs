import { describe, expect, it } from 'vitest';
import { evaluateInstallControl, SESSION_CHECK } from './install-control.mjs';

// The old install self-test inverted any failure, including a failed publish or scaffold crash.
// A broken registry therefore printed SELF-TEST PASSED without exercising an install.
describe('install negative control', () => {
  const expected = ['vite-react'];
  const detected = { id: 'vite-react', fail: 1, failedChecks: [SESSION_CHECK] };

  it('accepts only the intended session failure for every requested scaffold', () => {
    expect(evaluateInstallControl([detected], expected).ok).toBe(true);
  });

  it.each([
    [],
    [{ id: 'setup', fail: 1 }],
    [{ id: 'vite-react', fail: 1 }],
    [{ id: 'vite-react', fail: 0, failedChecks: [] }],
    [{ ...detected, fail: 2, failedChecks: [SESSION_CHECK, 'the app boots'] }],
    [{ ...detected, failedChecks: ['transport unavailable'] }],
    [detected, detected],
  ])('rejects absent, unrelated, inconclusive, or duplicate evidence: %j', (...results) => {
    expect(evaluateInstallControl(results, expected).ok).toBe(false);
  });

  it('does not excuse a passing monorepo control', () => {
    expect(
      evaluateInstallControl(
        [{ id: 'monorepo-subdir', fail: 0, failedChecks: [] }],
        ['monorepo-subdir'],
      ).ok,
    ).toBe(false);
  });
});
