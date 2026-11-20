import type { RadarItem, WatchTarget } from './types';

/**
 * Applies the freshest fetched items to a watch target and decides 動きあり / 動きなし.
 *
 * - "new" = items not seen in the previous check AND published after `since`
 *   (`since` = previous lastCheckedAt, or now − windowHours on the very first check).
 * - Items without a publish date (e.g. pinned X posts with no <time>) only count as new
 *   when they were never seen before AND this is not the first check.
 */
export function applyRadarResult(
  target: WatchTarget,
  fetched: RadarItem[],
  opts: { now?: number; windowHours: number }
): WatchTarget {
  const now = opts.now ?? Date.now();
  const isFirstCheck = !target.lastCheckedAt;
  const since = target.lastCheckedAt
    ? Date.parse(target.lastCheckedAt)
    : now - opts.windowHours * 3_600_000;
  const seen = new Set(target.lastSeenItemIds || []);

  const sorted = [...fetched].sort(
    (a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0)
  );

  const newItems = sorted.filter((item) => {
    const ts = Date.parse(item.publishedAt || '');
    if (Number.isFinite(ts)) {
      if (isFirstCheck) return ts > since;
      return ts > since || (!seen.has(item.id) && ts > now - opts.windowHours * 3_600_000);
    }
    return !isFirstCheck && !seen.has(item.id);
  });

  const latestTs = sorted
    .map((i) => Date.parse(i.publishedAt || ''))
    .filter((n) => Number.isFinite(n))
    .reduce((max, n) => Math.max(max, n), 0);

  const lastActivityAt = latestTs
    ? new Date(Math.max(latestTs, Date.parse(target.lastActivityAt || '') || 0)).toISOString()
    : target.lastActivityAt;

  return {
    ...target,
    lastCheckedAt: new Date(now).toISOString(),
    lastActivityAt,
    lastSeenItemIds: Array.from(new Set([...sorted.map((i) => i.id), ...seen])).slice(0, 60),
    newCount: newItems.length,
    latestItems: (newItems.length > 0 ? newItems : sorted).slice(0, 5),
    status: newItems.length > 0 ? 'active' : 'quiet',
    statusMessage: undefined,
  };
}

export function formatRelativeJa(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '不明';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '不明';
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}日前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}か月前`;
  return `${Math.floor(d / 365)}年前`;
}

/** Normalizes user input like "@foo", "x.com/foo", "https://twitter.com/foo" → "foo". */
export function normalizeXHandle(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = /(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(trimmed)?.[1];
  const raw = (fromUrl || trimmed).replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) return null;
  const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search']);
  return reserved.has(raw.toLowerCase()) ? null : raw;
}

/** Normalizes YouTube channel input to a canonical URL + optional channelId / handle. */
export function normalizeYouTubeChannelInput(
  input: string
): { url: string; channelId?: string; handle?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const idMatch = /(UC[\w-]{22})/.exec(trimmed);
  if (idMatch) {
    return { url: `https://www.youtube.com/channel/${idMatch[1]}`, channelId: idMatch[1] };
  }
  const handleMatch = /(?:youtube\.com\/)?(@[\w.\-]{2,})/.exec(trimmed);
  if (handleMatch) {
    return { url: `https://www.youtube.com/${handleMatch[1]}`, handle: handleMatch[1] };
  }
  if (/^https?:\/\/(www\.)?youtube\.com\/(c|user)\//.test(trimmed)) {
    return { url: trimmed.replace(/\/+$/, '') };
  }
  return null;
}

export function makeWatchTargetId(
  platform: WatchTarget['platform'],
  key: string
): string {
  return platform === 'youtube' ? `yt:${key}` : `x:${key.toLowerCase()}`;
}
