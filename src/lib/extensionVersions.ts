/**
 * Extension version constants.
 *
 * There are TWO different "latest" values, and they do NOT have to match:
 *
 * 1. PUBLIC_EXTENSION_VERSION — the version actually published on the
 *    Chrome Web Store. This is what every regular user sees. The
 *    "Extension Update Available" banner on the dashboard is driven by
 *    this — bumping it tells real users that a newer build is live and
 *    they should update from the store.
 *
 *    DO NOT bump this until the new build has been approved and is
 *    actually downloadable from the Chrome Web Store. Otherwise users
 *    get told to update to a version that doesn't exist yet, and the
 *    "Update Extension" CTA on the dashboard sends them to a store
 *    listing that's still on the old version.
 *
 * 2. INTERNAL_LATEST_VERSION — the latest build that exists in this
 *    repository (i.e. the newest zip in /public). This is what the
 *    admin "Builds" tab uses to show the latest internal build for
 *    side-loading and re-upload to the Web Store. Admins always see
 *    this; regular users never do.
 *
 * Workflow when shipping a new version:
 *   1. Build the zip (`futnor-extension-vX-Y-Z.zip`) into /public.
 *   2. Bump INTERNAL_LATEST_VERSION here. Push. Admins can now download
 *      and side-load the new build via /admin → Builds. Public users
 *      see no change.
 *   3. Upload the same zip to the Chrome Web Store dev console and
 *      submit for review.
 *   4. ONCE the Web Store has approved and published the new version,
 *      bump PUBLIC_EXTENSION_VERSION to match. Push. Public users now
 *      get the "Update available" banner and the dashboard shows the
 *      new version label.
 */

/** Version currently published on the Chrome Web Store (visible to all users). */
export const PUBLIC_EXTENSION_VERSION = '2.4.93';

/** Latest internal build in this repo (admin-only). */
export const INTERNAL_LATEST_VERSION = '2.4.149';

/**
 * Compare semver-ish version strings. Returns:
 *   negative if a < b
 *   0       if a === b
 *   positive if a > b
 *
 * Used so the "outdated extension" banner only fires when the user's
 * installed version is strictly less than the configured public version.
 */
export function compareExtensionVersions(a: string, b: string): number {
  const pa = (a || '').split('.').map((n) => Number(n) || 0);
  const pb = (b || '').split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
