import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFromDocument } from '../src/extractors';
import {
  extractChannelIdFromHtml,
  extractYouTubeVideoId,
  parseDurationLabel,
  parseJson3Transcript,
  parseRelativeTimeLabel,
  parseYouTubeChannelRss,
  parseYtInitialPlayerResponse,
  pickCaptionTrack,
} from '../src/extractors/youtube';
import {
  applyRadarResult,
  normalizeXHandle,
  normalizeYouTubeChannelInput,
} from '../src/shared/radar-utils';
import {
  buildHeuristicDigest,
  parseVideoDigestJson,
} from '../src/providers/video-digest';
import { buildRadarCandidates } from '../src/entrypoints/background/radar';
import { detectSourceFromUrl } from '../src/shared/url-utils';
import type { WatchTarget } from '../src/shared/types';

const NOW = Date.parse('2026-11-19T12:00:00Z');

function baseTarget(partial: Partial<WatchTarget> = {}): WatchTarget {
  return {
    id: 'yt:UCaaaaaaaaaaaaaaaaaaaaaa',
    platform: 'youtube',
    name: 'Test Channel',
    url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    enabled: true,
    addedAt: '2026-11-01T00:00:00Z',
    lastSeenItemIds: [],
    newCount: 0,
    latestItems: [],
    status: 'unknown',
    ...partial,
  };
}

describe('YouTube parsers', () => {
  it('detects youtube source and video ids', () => {
    expect(detectSourceFromUrl('https://www.youtube.com/feed/subscriptions')).toBe('youtube');
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://www.youtube.com/@foo')).toBeNull();
  });

  it('parses durations and relative times (ja/en)', () => {
    expect(parseDurationLabel('10:23')).toBe(623);
    expect(parseDurationLabel('1:02:03')).toBe(3723);
    expect(parseRelativeTimeLabel('1.2万 回視聴 · 3 時間前', NOW)).toBe('2026-11-19T09:00:00.000Z');
    expect(parseRelativeTimeLabel('2 days ago', NOW)).toBe('2026-11-17T12:00:00.000Z');
    expect(parseRelativeTimeLabel('ライブ配信予定', NOW)).toBeUndefined();
  });

  it('parses channel RSS feed', () => {
    const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Tech &amp; AI Channel</title><yt:channelId>UCaaaaaaaaaaaaaaaaaaaaaa</yt:channelId>
      <entry><yt:videoId>AAAAAAAAAAA</yt:videoId><title>新作レビュー</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/>
        <published>2026-11-19T08:00:00+00:00</published>
        <media:group><media:description>Gemini 3 の新機能を10分で解説</media:description></media:group></entry>
      <entry><yt:videoId>BBBBBBBBBBB</yt:videoId><title>先週の動画</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=BBBBBBBBBBB"/>
        <published>2026-11-10T08:00:00+00:00</published></entry>
    </feed>`;
    const res = parseYouTubeChannelRss(xml);
    expect(res.channelTitle).toBe('Tech & AI Channel');
    expect(res.channelId).toBe('UCaaaaaaaaaaaaaaaaaaaaaa');
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({ id: 'AAAAAAAAAAA', title: '新作レビュー' });
    expect(res.items[0].excerpt).toContain('Gemini 3');
  });

  it('extracts channel id and player response with captions', () => {
    expect(extractChannelIdFromHtml('..."externalId":"UCbbbbbbbbbbbbbbbbbbbbbb",...')).toBe('UCbbbbbbbbbbbbbbbbbbbbbb');
    const player = {
      videoDetails: { videoId: 'AAAAAAAAAAA', title: 'T {brace} "q"', author: 'Ch', lengthSeconds: '615', shortDescription: '00:00 intro\n02:10 本題' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { baseUrl: 'https://x/en', languageCode: 'en', name: { simpleText: 'English' } },
        { baseUrl: 'https://x/ja-asr', languageCode: 'ja', kind: 'asr', name: { simpleText: '日本語 (自動生成)' } },
      ] } },
    };
    const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = {};</script>`;
    const info = parseYtInitialPlayerResponse(html);
    expect(info?.title).toBe('T {brace} "q"');
    expect(info?.lengthSec).toBe(615);
    expect(pickCaptionTrack(info!.captionTracks)?.languageCode).toBe('ja');
  });

  it('builds timestamped transcript from json3', () => {
    const t = parseJson3Transcript({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'こんにちは' }] },
        { tStartMs: 5000, segs: [{ utf8: '今日は' }] },
        { tStartMs: 65000, segs: [{ utf8: '本題です' }] },
      ],
    });
    expect(t.split('\n')).toEqual(['[00:00] こんにちは今日は', '[01:05] 本題です']);
  });

  it('extracts subscription feed cards via extractFromDocument', () => {
    const doc = new JSDOM(
      `<ytd-rich-item-renderer>
        <a id="video-title-link" href="/watch?v=AAAAAAAAAAA"><yt-formatted-string id="video-title">Gemini 3 徹底解説</yt-formatted-string></a>
        <ytd-channel-name><a href="/@techch">Tech Ch</a></ytd-channel-name>
        <div id="metadata-line"><span>1万 回視聴</span><span>3 時間前</span></div>
        <ytd-thumbnail-overlay-time-status-renderer>10:05</ytd-thumbnail-overlay-time-status-renderer>
      </ytd-rich-item-renderer>`,
      { url: 'https://www.youtube.com/feed/subscriptions' }
    ).window.document;
    const res = extractFromDocument(doc, 'https://www.youtube.com/feed/subscriptions');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({
      source: 'youtube',
      url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      author: 'Tech Ch',
      authorHandle: '@techch',
    });
    expect(res.candidates[0].content).toContain('10:05');
  });
});

describe('Follow radar status', () => {
  const items = [
    { id: 'new1', title: 'new', url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', publishedAt: '2026-11-19T10:00:00Z' },
    { id: 'old1', title: 'old', url: 'u2', publishedAt: '2026-11-01T10:00:00Z' },
  ];

  it('marks active on first check when something was posted inside the window', () => {
    const t = applyRadarResult(baseTarget(), items, { now: NOW, windowHours: 72 });
    expect(t.status).toBe('active');
    expect(t.newCount).toBe(1);
    expect(t.latestItems[0].id).toBe('new1');
    expect(t.lastActivityAt).toBe('2026-11-19T10:00:00.000Z');
  });

  it('marks quiet when nothing new since last check, keeping last activity', () => {
    const first = applyRadarResult(baseTarget(), items, { now: NOW, windowHours: 72 });
    const second = applyRadarResult(first, items, { now: NOW + 3_600_000, windowHours: 72 });
    expect(second.status).toBe('quiet');
    expect(second.newCount).toBe(0);
    expect(second.lastActivityAt).toBe('2026-11-19T10:00:00.000Z');
  });

  it('normalizes handles and channel inputs', () => {
    expect(normalizeXHandle('https://x.com/OpenAI/status/1')).toBe('OpenAI');
    expect(normalizeXHandle('@foo_bar')).toBe('foo_bar');
    expect(normalizeXHandle('home')).toBeNull();
    expect(normalizeYouTubeChannelInput('https://www.youtube.com/@techch/videos')).toMatchObject({ handle: '@techch' });
    expect(normalizeYouTubeChannelInput('UCaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('builds radar episode material with an active/quiet summary item', () => {
    const active = applyRadarResult(baseTarget(), items, { now: NOW, windowHours: 72 });
    const quiet = { ...baseTarget({ id: 'x:quiet', platform: 'x', name: 'Quiet', handle: 'quiet' }), status: 'quiet' as const, lastCheckedAt: '2026-11-19T11:00:00Z', lastActivityAt: '2026-11-10T00:00:00Z' };
    const cands = buildRadarCandidates([active, quiet], new Map(), NOW);
    expect(cands.some((c) => c.source === 'youtube' && c.title.includes('new'))).toBe(true);
    const summary = cands.find((c) => c.title === '登録チャンネル・フォロー動向サマリー');
    expect(summary?.content).toContain('動きあり 1 件 / 動きなし 1 件');
    expect(summary?.content).toContain('Quiet（最終: 9日前）');
  });
});

describe('Video digest parsing', () => {
  const material = {
    info: { videoId: 'AAAAAAAAAAA', title: 'Gemini 3 解説', author: 'Tech Ch', lengthSec: 600, description: '00:00 イントロ\n02:10 AI エージェントの新機能\nAI・テクノロジーの最新動向を紹介します。', captionTracks: [] },
    transcript: '',
  };

  it('parses LLM JSON wrapped in code fences', () => {
    const d = parseVideoDigestJson(
      '```json\n{"oneLiner":"新機能まとめ","summary":["a","b"],"keyPoints":[{"time":"02:10","point":"エージェント"}],"verdict":"Watch","verdictReason":"関心と一致","relevance":88}\n```',
      material,
      'transcript'
    );
    expect(d.verdict).toBe('watch');
    expect(d.keyPoints[0]).toEqual({ time: '02:10', point: 'エージェント' });
    expect(d.relevance).toBe(88);
  });

  it('falls back to heuristic digest using description chapters', () => {
    const d = buildHeuristicDigest(material, 'AI・テクノロジー');
    expect(d.method).toBe('heuristic');
    expect(d.keyPoints).toHaveLength(2);
    expect(d.verdict).toBe('watch');
  });
});
