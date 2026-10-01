export const SESSION_CHECK = 'a session appears and can answer a state question';

/** A setup error is missing evidence, never a successful negative control. */
export function evaluateInstallControl(results, expectedIds) {
  const problems = [];
  if (expectedIds.length === 0) problems.push('no scaffolds requested');
  for (const id of expectedIds) {
    const rows = results.filter((result) => result.id === id);
    if (rows.length !== 1) {
      problems.push(`${id}: expected one result, got ${rows.length}`);
      continue;
    }
    const row = rows[0];
    if (row.fail !== 1 || row.failedChecks?.length !== 1 || row.failedChecks[0] !== SESSION_CHECK) {
      problems.push(`${id}: expected only the session failure; got ${JSON.stringify(row)}`);
    }
  }
  for (const row of results) {
    if (!expectedIds.includes(row.id)) problems.push(`unexpected result: ${row.id}`);
  }
  return { ok: problems.length === 0, problems };
}
