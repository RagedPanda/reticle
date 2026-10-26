#!/usr/bin/env node
/**
 * Refuse a publish that would skip a package whose dependencies changed under an unchanged version.
 *
 * `pnpm -r publish` skips any version already on npm. That is what makes a failed publish safe to
 * re-run, and it is also how 3.8.1 shipped broken: `open-verification` moved from zod 3 to zod 4 but
 * stayed at 1.0.0 (it is not lockstepped), so the publish skipped it, `@reticlehq/core@3.8.1` pinned
 * the zod 3 build already on npm, and every run that core parsed threw "Invalid element at key
 * \"subject\": expected a Zod schema". Nothing failed until a user ran it.
 *
 * For every public workspace package whose version is already on npm, the dependencies npm has must
 * be the ones this tree would publish. A difference means the content changed and the version did
 * not: bump it. `workspace:*` is read as the version the workspace package carries, since that is
 * what pnpm writes at pack time.
 *
 * usage: node scripts/check-unbumped-packages.mjs        (exit 1 and a list when any differ)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Every non-private workspace package, by name, with its directory and manifest. */
const workspacePackages = () => {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: ROOT, encoding: 'utf8' }),
  );
  const out = new Map();
  for (const { path } of listed) {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (true !== manifest.private && 'string' === typeof manifest.name) {
      out.set(manifest.name, manifest);
    }
  }
  return out;
};

/** The dependency map pnpm would publish: `workspace:` ranges become the sibling's version. */
export const publishedDependencies = (manifest, siblings) =>
  Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, range]) => {
      if (!String(range).startsWith('workspace:')) {
        return [name, range];
      }
      const sibling = siblings.get(name);
      return [name, undefined === sibling ? range : sibling.version];
    }),
  );

/** The differences between two dependency maps, as `name: npm → local` lines. */
export const differences = (onNpm, local) => {
  const names = [...new Set([...Object.keys(onNpm ?? {}), ...Object.keys(local)])].sort();
  return names
    .filter((name) => (onNpm ?? {})[name] !== local[name])
    .map(
      (name) =>
        `${name}: ${String((onNpm ?? {})[name] ?? '(none)')} → ${String(local[name] ?? '(none)')}`,
    );
};

const npmManifest = (name, version) => {
  try {
    return JSON.parse(
      execFileSync('npm', ['view', `${name}@${version}`, 'dependencies', 'version', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null; // not on npm yet: this publish will ship it, nothing to compare
  }
};

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const siblings = workspacePackages();
  const stale = [];
  for (const [name, manifest] of siblings) {
    const onNpm = npmManifest(name, manifest.version);
    if (null === onNpm) {
      continue;
    }
    const diff = differences(onNpm.dependencies, publishedDependencies(manifest, siblings));
    if (0 < diff.length) {
      stale.push(
        `${name}@${manifest.version} is on npm with other dependencies:\n  ${diff.join('\n  ')}`,
      );
    }
  }
  if (0 < stale.length) {
    console.error(
      `check-unbumped-packages: these would be skipped by the publish while their content changed. Bump their versions.\n${stale.join('\n')}`,
    );
    process.exit(1);
  }
  console.log(
    `check-unbumped-packages: ${String(siblings.size)} public packages, none changed under a published version`,
  );
}
