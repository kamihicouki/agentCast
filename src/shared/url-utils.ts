import type { SourceId } from './types';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'ref',
  'ref_src',
  'ref_url',
  's',
  't',
  'feature',
]);

export function canonicalizeUrl(rawUrl: string, baseUrl?: string): string {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    if (parsed.hostname === 'twitter.com') {
      parsed.hostname = 'x.com';
    }
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    // Strip trailing slash except root
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function computeItemId(source: SourceId, canonicalUrl: string, titleFallback = ''): string {
  const seed = `${source}::${canonicalUrl || titleFallback}`;
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `${source}-${hex}`;
}

export function detectSourceFromUrl(rawUrl: string): SourceId {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com') return 'x';
    if (host === 'note.com' || host.endsWith('.note.com')) return 'note';
    if (host === 'zenn.dev' || host.endsWith('.zenn.dev')) return 'zenn';
    if (host === 'news.yahoo.co.jp') return 'yahoo_news';
    if (host === 'news.google.com') return 'google_news';
    return 'generic';
  } catch {
    return 'generic';
  }
}

export function makeExcerpt(text: string, maxLen = 140): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1)}…`;
}
