/**
 * Helpers for requesting optional_host_permissions on demand in the Chrome Web Store build.
 * Must be called inside a user gesture (e.g., button click handler in the Side Panel).
 */

export function toOriginPattern(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export function collectOriginPatterns(urls: string[]): string[] {
  const set = new Set<string>();
  for (const url of urls) {
    const pat = toOriginPattern(url);
    if (pat) set.add(pat);
  }
  return Array.from(set);
}

/**
 * Checks whether the extension already has host permission for all given URLs,
 * and requests missing origins via chrome.permissions.request if needed.
 * Returns true if permissions are granted (or if no HTTP URLs were given).
 */
export async function ensureHostPermissionsForUrls(urls: string[]): Promise<boolean> {
  const origins = collectOriginPatterns(urls);
  if (origins.length === 0) return true;
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;

  try {
    const already = await chrome.permissions.contains({ origins });
    if (already) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    // In environments where optional_host_permissions isn't declared (e.g. main build with <all_urls>),
    // chrome.permissions.request may throw if origins aren't listed as optional; fall back to contains check.
    try {
      return await chrome.permissions.contains({ origins });
    } catch {
      return true;
    }
  }
}
