import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { resolveStateDir } from './state-dir.js';

/**
 * A relative state folder is created inside whatever folder the process runs in, often the project.
 * On Windows a `C:` folder appeared inside the app, with the pairing token under it. A POSIX Node
 * reads `C:\...` as a relative path.
 */
describe('resolveStateDir', () => {
  const home = '/home/u/.reticle';

  it('uses the override when it is absolute', () => {
    expect(resolveStateDir('/srv/state', home, posix.isAbsolute)).toBe('/srv/state');
  });

  it('uses the fallback when there is no override', () => {
    expect(resolveStateDir(undefined, home, posix.isAbsolute)).toBe(home);
    expect(resolveStateDir('', home, posix.isAbsolute)).toBe(home);
  });

  it('refuses a Windows-style path under POSIX path rules', () => {
    expect(() => resolveStateDir('C:\\Users\\u\\.reticle', home, posix.isAbsolute)).toThrow(
      /not an absolute path/,
    );
  });

  it('refuses a relative fallback, such as a home folder that is not absolute', () => {
    expect(() => resolveStateDir(undefined, 'C:\\Users\\u/.reticle', posix.isAbsolute)).toThrow(
      /C:\\Users/,
    );
  });
});
