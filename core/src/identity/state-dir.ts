import { ReticleEnv } from '../wire/constants/reticle-env.js';

/** Why a state or token folder was refused. Names the variables that move it. */
export const stateDirNotAbsolute = (dir: string): string =>
  `The Reticle state folder "${dir}" is not an absolute path, so Reticle did not use it. A ` +
  'relative folder is made inside the folder this process runs in, which is often the project. ' +
  `Set ${ReticleEnv.PAIRING_TOKEN_DIR} and ${ReticleEnv.STATE_DIR} to absolute paths, or unset them.`;

/**
 * The folder for the pairing token or other machine state: the override when it is set, else the
 * fallback. Throws when the result is not an absolute path.
 *
 * A relative folder is made inside the folder the process runs in. On Windows a `C:` folder was
 * made inside an app, with the pairing token under it, where git can commit it. A POSIX Node (WSL,
 * a container) reads a Windows-style `C:\...` path as relative. `isAbsolute` is the caller's
 * `node:path` rule, because core imports no Node module.
 */
export function resolveStateDir(
  override: string | undefined,
  fallback: string,
  isAbsolute: (path: string) => boolean,
): string {
  const dir = override !== undefined && override.length > 0 ? override : fallback;
  if (!isAbsolute(dir)) {
    throw new Error(stateDirNotAbsolute(dir));
  }
  return dir;
}
