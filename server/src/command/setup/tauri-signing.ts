/**
 * Sign the Tauri dev build Reticle starts with the project's own signing identity, so macOS stops
 * asking for the keychain password.
 *
 * macOS ties a keychain item to the designated requirement of the app that saved it: its code
 * identifier and its signing team. `tauri dev` produces an ad-hoc signed binary named after the
 * crate, so every keychain read from it is a different app asking, and macOS prompts each time.
 * `reticle doctor` explained that; this removes it when the project has said who signs it.
 *
 * `APPLE_SIGNING_IDENTITY` cannot simply be passed through: Tauri reads it only when it bundles
 * (`tauri build`), never in `tauri dev`. What `tauri dev` does run is `cargo run`, and Cargo hands
 * the freshly built binary to a per-target RUNNER before executing it. The runner written here signs
 * that binary — with the identity, and with the app's bundle identifier so the requirement matches
 * the release app's — and then executes it unchanged. A signing failure is said on stderr and never
 * stops the app.
 *
 * Nothing happens off macOS, outside a Tauri project, with no identity, with the ad-hoc identity
 * `-` (which matches nothing), or when the project already sets a Cargo runner of its own.
 */
import { join } from 'node:path';

/** The env the runner reads its arguments from: the script stays a fixed file. */
export const SigningEnv = {
  IDENTITY: 'RETICLE_SIGNING_IDENTITY',
  IDENTIFIER: 'RETICLE_SIGNING_IDENTIFIER',
  APPLE: 'APPLE_SIGNING_IDENTITY',
} as const;

/** Cargo's runner variable for each Mac target `tauri dev` builds. */
const RUNNER_VARS = [
  'CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER',
  'CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER',
] as const;

const DARWIN = 'darwin';
const AD_HOC = '-';
const TAURI_CONF = join('src-tauri', 'tauri.conf.json');
export const RUNNER_FILE = 'tauri-sign-runner.sh';

/** The runner: sign the binary Cargo built, then run it exactly as Cargo would have. */
export const RUNNER_SCRIPT = `#!/bin/sh
# Written by Reticle. Signs the Tauri dev build with this project's signing identity before it
# starts, so macOS treats it as the app that owns your keychain items and stops asking for the
# password. Remove RETICLE_SIGNING_IDENTITY from the environment to turn it off.
codesign --force --sign "$${SigningEnv.IDENTITY}" --identifier "$${SigningEnv.IDENTIFIER}" "$1" >/dev/null 2>&1 ||
  echo "reticle: could not sign $1 with $${SigningEnv.IDENTITY}; macOS may ask for the keychain password" >&2
exec "$@"
`;

export interface SigningDeps {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A file's text relative to the app directory, or undefined when it is absent. */
  readonly read: (path: string) => string | undefined;
  /** Writes the runner and makes it executable; returns its absolute path. */
  readonly writeRunner: (name: string, script: string) => string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};
const asText = (value: unknown): string | undefined =>
  'string' === typeof value && 0 < value.trim().length ? value.trim() : undefined;

/** The extra env for starting a Tauri dev build signed, or `{}` when there is nothing to sign with. */
export function tauriSigningEnv(deps: SigningDeps): Record<string, string> {
  if (DARWIN !== deps.platform) {return {};}
  const raw = deps.read(TAURI_CONF);
  if (raw === undefined) {return {};}
  let conf: Record<string, unknown>;
  try {
    conf = asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
  const macOS = asRecord(asRecord(conf['bundle'])['macOS']);
  const identity = asText(deps.env[SigningEnv.APPLE]) ?? asText(macOS['signingIdentity']);
  const identifier = asText(conf['identifier']);
  if (identity === undefined || AD_HOC === identity || identifier === undefined) {return {};}
  // A project that runs its builds through a runner of its own keeps it.
  if (RUNNER_VARS.some((name) => deps.env[name] !== undefined)) {return {};}
  const runner = deps.writeRunner(RUNNER_FILE, RUNNER_SCRIPT);
  // Cargo splits a runner given in the environment on whitespace, so a path with a space in it
  // would run the wrong program. ponytail: skip it; doctor still explains the prompt.
  if (/\s/.test(runner)) {return {};}
  return {
    [SigningEnv.IDENTITY]: identity,
    [SigningEnv.IDENTIFIER]: identifier,
    ...Object.fromEntries(RUNNER_VARS.map((name) => [name, runner])),
  };
}
