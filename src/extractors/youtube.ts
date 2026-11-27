import type { ExtractedCandidate, RadarItem } from '../shared/types';

// ---------------------------------------------------------------------------
// Small helpers (pure, Service-Worker safe)
// ---------------------------------------------------------------------------

function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, 'https://www.youtube.com');
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (!u.hostname.endsWith('youtube.com')) return null;
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** "10:23" / "1:02:03" → seconds. Returns undefined when not a duration label. */
export function parseDurationLabel(label: string | null | undefined): number | undefined {
  if (!label) return undefined;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(label.trim());
  if (!m) return undefined;
  if (m[3] !== undefined) {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatDurationSec(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Converts YouTube relative time labels to an approximate ISO timestamp.
 * Supports Japanese ("3 時間前", "2日前", "1 か月前") and English ("5 minutes ago").
 */
export function parseRelativeTimeLabel(label: string, now = Date.now()): string | undefined {
  const text = label.replace(/\s+/g, ' ').trim().toLowerCase();
  const units: [RegExp, number][] = [
    [/(\d+)\s*(秒|seconds?|secs?)/, 1_000],
    [/(\d+)\s*(分|minutes?|mins?)/, 60_000],
    [/(\d+)\s*(時間|hours?|hrs?)/, 3_600_000],
    [/(\d+)\s*(日|days?)/, 86_400_000],
    [/(\d+)\s*(週間|weeks?)/, 7 * 86_400_000],
    [/(\d+)\s*(か月|ヶ月|カ月|months?)/, 30 * 86_400_000],
    [/(\d+)\s*(年|years?)/, 365 * 86_400_000],
  ];
  if (!/前|ago/.test(text)) return undefined;
  for (const [re, ms] of units) {
    const m = re.exec(text);
    if (m) return new Date(now - Number(m[1]) * ms).toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// DOM extractors (content script)
// ---------------------------------------------------------------------------

const VIDEO_CARD_SELECTOR = [
  'ytd-rich-item-renderer',
  'ytd-grid-video-renderer',
  'ytd-video-renderer',
  'ytd-playlist-video-renderer',
  'yt-lockup-view-model',
].join(', ');

export function extractYouTubeSubscriptions(doc: Document, now = Date.now()): ExtractedCandidate[] {
  const cards = Array.from(doc.querySelectorAll(VIDEO_CARD_SELECTOR));
  const seen = new Set<string>();
  const results: ExtractedCandidate[] = [];

  for (const card of cards) {
    // Skip nested duplicates (lockup inside rich-item)
    if (card.parentElement?.closest(VIDEO_CARD_SELECTOR)) continue;

    const anchor =
      card.querySelector<HTMLAnchorElement>('a#video-title-link, a#video-title') ||
      card.querySelector<HTMLAnchorElement>('a[href*="/watch?v="], a[href^="/shorts/"]');
    const href = anchor?.getAttribute('href') || '';
    const videoId = extractYouTubeVideoId(href);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);

    const title = (
      card.querySelector('#video-title')?.textContent ||
      anchor?.getAttribute('title') ||
      card.querySelector('h3')?.textContent ||
      anchor?.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;

    const channelAnchor =
      card.querySelector<HTMLAnchorElement>('ytd-channel-name a') ||
      card.querySelector<HTMLAnchorElement>('a[href^="/@"], a[href^="/channel/"]');
    const channelName = (
      channelAnchor?.textContent ||
      card.querySelector('ytd-channel-name')?.textContent ||
      'YouTube'
    )
      .replace(/\s+/g, ' ')
      .trim();
    const channelHref = channelAnchor?.getAttribute('href') || '';
    const handle = /^\/(@[^/?#]+)/.exec(channelHref)?.[1];

    const metaText = Array.from(
      card.querySelectorAll('#metadata-line span, .inline-metadata-item, yt-content-metadata-view-model span')
    )
      .map((s) => (s.textContent || '').trim())
      .filter(Boolean)
      .join(' · ');
    const publishedAt = parseRelativeTimeLabel(metaText, now);

    const durationLabel =
      card.querySelector('ytd-thumbnail-overlay-time-status-renderer, badge-shape, .badge-shape-wiz__text')
        ?.textContent || '';
    const durationSec = parseDurationLabel(durationLabel);
    const isShort = href.startsWith('/shorts/');

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    results.push({
      source: 'youtube',
      url,
      title: `${channelName}: ${title}`,
      author: channelName,
      authorHandle: handle,
      content: [
        `YouTube新着動画「${title}」（チャンネル: ${channelName}）`,
        durationSec ? `長さ ${formatDurationSec(durationSec)}` : isShort ? 'ショート動画' : '',
        metaText,
      ]
        .filter(Boolean)
        .join(' / '),
      outboundUrls: [url],
      publishedAt,
      engagementScore: 1.4,
    });
  }

  return results;
}

export function extractYouTubeWatchPage(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const videoId = extractYouTubeVideoId(pageUrl);
  if (!videoId) return [];
  const title = (
    doc.querySelector('ytd-watch-metadata h1')?.textContent ||
    doc.querySelector('meta[name="title"]')?.getAttribute('content') ||
    doc.title.replace(/\s*-\s*YouTube\s*$/, '')
  )
    .replace(/\s+/g, ' ')
    .trim();
  const channel = (
    doc.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')?.textContent ||
    doc.querySelector('link[itemprop="name"]')?.getAttribute('content') ||
    'YouTube'
  )
    .replace(/\s+/g, ' ')
    .trim();
  const description = (
    doc.querySelector('#description-inline-expander, ytd-text-inline-expander')?.textContent ||
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return [];
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return [
    {
      source: 'youtube',
      url,
      title: `${channel}: ${title}`,
      author: channel,
      content: `YouTube動画「${title}」（${channel}）。概要: ${description.slice(0, 2000)}`,
      outboundUrls: [url],
      engagementScore: 1.6,
    },
  ];
}

export function extractYouTube(doc: Document, pageUrl: string): ExtractedCandidate[] {
  if (extractYouTubeVideoId(pageUrl)) return extractYouTubeWatchPage(doc, pageUrl);
  return extractYouTubeSubscriptions(doc);
}

// ---------------------------------------------------------------------------
// Channel RSS + player response + captions (Service Worker side, string-based)
// ---------------------------------------------------------------------------

export function parseYouTubeChannelRss(xml: string): {
  channelTitle: string;
  channelId?: string;
  items: RadarItem[];
} {
  const headEnd = xml.search(/<entry\b/i);
  const head = headEnd >= 0 ? xml.slice(0, headEnd) : xml;
  const channelTitle = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] || '');
  const channelId = /<yt:channelId>([^<]+)<\/yt:channelId>/i.exec(head)?.[1]?.trim();

  const items: RadarItem[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null && items.length < 15) {
    const block = m[1];
    const videoId = /<yt:videoId>([^<]+)<\/yt:videoId>/i.exec(block)?.[1]?.trim();
    const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || '');
    const link =
      /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block)?.[1] ||
      (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    const published = /<published>([^<]+)<\/published>/i.exec(block)?.[1]?.trim();
    const desc = decodeEntities(
      /<media:description[^>]*>([\s\S]*?)<\/media:description>/i.exec(block)?.[1] || ''
    );
    if (!videoId && !link) continue;
    items.push({
      id: videoId || link,
      title,
      url: link,
      publishedAt: published,
      excerpt: desc.replace(/\s+/g, ' ').slice(0, 220),
    });
  }
  return { channelTitle, channelId, items };
}

/** Finds `"externalId":"UC…"` / canonical `/channel/UC…` inside a channel page HTML. */
export function extractChannelIdFromHtml(html: string): string | undefined {
  return (
    /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1] ||
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1] ||
    /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1] ||
    /\/channel\/(UC[\w-]{22})/.exec(html)?.[1]
  );
}

/** Brace-matches a JSON object assigned to `varName` inside an HTML page. */
export function extractJsonAssignment(html: string, varName: string): unknown | null {
  const markerIdx = html.search(new RegExp(`${varName}\\s*=\\s*\\{`));
  if (markerIdx < 0) return null;
  const start = html.indexOf('{', markerIdx);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface YouTubePlayerInfo {
  videoId: string;
  title: string;
  author: string;
  channelId?: string;
  lengthSec: number;
  description: string;
  captionTracks: { baseUrl: string; languageCode: string; kind?: string; name: string }[];
}

export function parseYtInitialPlayerResponse(html: string): YouTubePlayerInfo | null {
  const data = extractJsonAssignment(html, 'ytInitialPlayerResponse') as {
    videoDetails?: {
      videoId?: string;
      title?: string;
      author?: string;
      channelId?: string;
      lengthSeconds?: string;
      shortDescription?: string;
    };
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: {
          baseUrl?: string;
          languageCode?: string;
          kind?: string;
          name?: { simpleText?: string; runs?: { text: string }[] };
        }[];
      };
    };
  } | null;
  const vd = data?.videoDetails;
  if (!vd?.videoId) return null;
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return {
    videoId: vd.videoId,
    title: vd.title || '',
    author: vd.author || '',
    channelId: vd.channelId,
    lengthSec: Number(vd.lengthSeconds || 0),
    description: vd.shortDescription || '',
    captionTracks: tracks
      .filter((t) => t.baseUrl)
      .map((t) => ({
        baseUrl: t.baseUrl!,
        languageCode: t.languageCode || '',
        kind: t.kind,
        name: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join('') || t.languageCode || '',
      })),
  };
}

/** Prefers manual ja → asr ja → manual en → anything. */
export function pickCaptionTrack(
  tracks: YouTubePlayerInfo['captionTracks']
): YouTubePlayerInfo['captionTracks'][number] | undefined {
  const score = (t: YouTubePlayerInfo['captionTracks'][number]) => {
    const lang = t.languageCode.toLowerCase();
    let s = 0;
    if (lang.startsWith('ja')) s += 10;
    else if (lang.startsWith('en')) s += 5;
    if (t.kind !== 'asr') s += 2;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

/** json3 caption payload → "[mm:ss] text" lines grouped ~every 20s, capped by maxChars. */
export function parseJson3Transcript(json: unknown, maxChars = 24000): string {
  const events = (json as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] })?.events;
  if (!Array.isArray(events)) return '';
  const lines: string[] = [];
  let bucketStart = -1;
  let bucket = '';
  const flush = () => {
    const text = bucket.replace(/\s+/g, ' ').trim();
    if (text) {
      const sec = Math.floor(bucketStart / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      lines.push(`[${mm}:${ss}] ${text}`);
    }
    bucket = '';
  };
  for (const ev of events) {
    if (!ev.segs) continue;
    const t = ev.tStartMs ?? 0;
    if (bucketStart < 0) bucketStart = t;
    if (t - bucketStart >= 20_000) {
      flush();
      bucketStart = t;
    }
    bucket += ev.segs.map((s) => s.utf8 || '').join('');
  }
  flush();
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（以下省略）`;
  return out;
}

/** Fallback XML caption format (`<text start="1.2">…</text>`). */
export function parseXmlTranscript(xml: string, maxChars = 24000): string {
  const re = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  const events: { tStartMs: number; segs: { utf8: string }[] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    events.push({ tStartMs: Math.round(Number(m[1]) * 1000), segs: [{ utf8: `${decodeEntities(m[2])} ` }] });
  }
  return parseJson3Transcript({ events }, maxChars);
}
