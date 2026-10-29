/**
 * What to do about a response body that was truncated before it was recorded, for the inconclusive
 * verdict `evalNet` gives when the wanted body is not in the kept part.
 */
import { sdkPredates } from './predicate-eval-kit.js';

/** A truncated body missed a `bodyContains`: the kept prefix can still answer a substring. */
const TRUNCATED_PREFIX_REMEDY =
  "Raise it past this response's size and re-run, or assert on something inside the recorded prefix";

/**
 * A truncated body missed a `bodyMatches`. That clause parses the whole body and a JSON prefix never
 * parses, so "assert inside the prefix" changes nothing for it (#1417): name what can work instead.
 */
const TRUNCATED_MATCHES_REMEDY =
  "Raise it past this response's size and re-run. `bodyMatches` parses the whole body, and a JSON prefix never parses, so it cannot be judged on the kept part: to assert on what was kept, use `bodyContains` with a substring from it";

/** The first SDK release that reads `networkBodyMaxChars`; an older one caps every body at 8192 (#2031). */
const BODY_MAX_CHARS_SINCE = '3.3.0';

/**
 * How to keep more of a truncated body. On an SDK that predates the option, raising it changes
 * nothing, so the only advice that works is updating the SDK: say that instead (#2031).
 */
export function truncatedBodyAdvice(sdkVersion: string | undefined, missedMatch: boolean): string {
  const remedy = missedMatch ? TRUNCATED_MATCHES_REMEDY : TRUNCATED_PREFIX_REMEDY;
  if (sdkPredates(sdkVersion, BODY_MAX_CHARS_SINCE)) {
    return `This page's SDK ${String(sdkVersion)} caps every recorded body at 8192 characters and ignores \`networkBodyMaxChars\`, which arrived in ${BODY_MAX_CHARS_SINCE}, so raising it changes nothing yet. Run \`reticle update\` in the app's folder, then restart its dev server. After that the cap is \`networkBodyMaxChars\`, set where the app calls connect(). ${remedy}`;
  }
  return `The cap is per-body and set where the app calls connect(): \`reticle.connect({ captureNetworkBodies: true, networkBodyMaxChars: 65536 })\`, or for the Vite plugin \`reticle({ networkBodyMaxChars: 65536 })\` / VITE_RETICLE_BODY_MAX_CHARS=65536 (default 8192, max 262144). An SDK older than this daemon ignores the option; a version skew on the session says so. ${remedy}`;
}
