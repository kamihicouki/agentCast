/**
 * Helpers for requesting optional_host_permissions on demand in the Chrome Web Store build.
 * Must be called inside a user gesture (e.g., button click handler in the Side Panel).
 */

import { DATA_CONSENT_REQUIRED } from './data-consent';
import type { RuntimeRequest } from './messages';
import { PATROL_SOURCE_IDS, SOURCE_META, type CustomSiteConfig, type ExtensionSettings } from './types';

export function toOriginPattern(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && (DATA_CONSENT_REQUIRED || u.protocol !== 'http:')) return null;
    if (u.username || u.password) return null;
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
  if (origins.length === 0) return urls.length === 0;
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
      return false;
    }
  }
}

export async function canReadPage(url: string): Promise<boolean> {
  const origin = toOriginPattern(url);
  return Boolean(origin && await chrome.permissions.contains({ origins: [origin] }));
}

export function matchesPassiveSite(url: string, sites: CustomSiteConfig[] = []): boolean {
  const origin = toOriginPattern(url);
  if (!origin) return false;
  const page = new URL(url);
  return sites.some((site) => {
    if (!site.enabled || !site.passiveEnabled || site.extractionStrategy === 'rss' ||
        toOriginPattern(site.url) !== origin) return false;
    const target = new URL(site.url);
    if (target.origin !== page.origin) return false;
    const path = target.pathname.replace(/\/+$/, '');
    return !path || page.pathname === path || page.pathname.startsWith(path + '/');
  });
}

const YOUTUBE_URL = 'https://www.youtube.com/';
const X_URL = 'https://x.com/';

export function patrolPermissionUrls(settings: ExtensionSettings): string[] {
  const builtins = PATROL_SOURCE_IDS
    .filter((id) => settings.enabledSources[id] && !settings.removedBuiltinSources?.includes(id))
    .map((id) => SOURCE_META[id].startUrl);
  const custom = (settings.customSites || []).filter((site) => site.enabled).map((site) => site.url);
  return [...builtins, ...custom, ...(settings.radarIncludeInPatrol ? [YOUTUBE_URL, X_URL] : [])]
    .filter(toOriginPattern);
}

export function requestPatrolPermissions(
  message: RuntimeRequest, settings: ExtensionSettings
): Promise<boolean> {
  switch (message.type) {
    case 'PATROL_SOURCES':
    case 'PATROL_AND_GENERATE':
      return ensureHostPermissionsForUrls(message.sources
        ? message.sources.map((id) => SOURCE_META[id].startUrl).filter(Boolean)
        : patrolPermissionUrls(settings));
    case 'PATROL_CUSTOM_SITE': {
      const target = settings.customSites.find((site) => site.id === message.siteId);
      return target ? ensureHostPermissionsForUrls([target.url]) : Promise.resolve(false);
    }
    case 'RADAR_IMPORT_YOUTUBE_SUBS':
    case 'SUMMARIZE_YOUTUBE_VIDEO':
    case 'SUMMARIZE_ACTIVE_YOUTUBE_TAB':
      return ensureHostPermissionsForUrls([YOUTUBE_URL]);
    case 'RADAR_IMPORT_X_FOLLOWING':
      return ensureHostPermissionsForUrls([X_URL]);
    case 'RADAR_ADD_TARGET':
      return message.platform === 'youtube' ? ensureHostPermissionsForUrls([YOUTUBE_URL]) : Promise.resolve(true);
    case 'RADAR_CHECK':
      return ensureHostPermissionsForUrls((message.platforms ?? ['youtube', 'x'])
        .map((platform) => platform === 'youtube' ? YOUTUBE_URL : X_URL));
    case 'RADAR_GENERATE_EPISODE':
      return message.checkFirst ? ensureHostPermissionsForUrls([YOUTUBE_URL, X_URL]) : Promise.resolve(true);
    default:
      return Promise.resolve(true);
  }
}
