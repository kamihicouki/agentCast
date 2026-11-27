import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGeminiWithRetry,
  formatFriendlyGeminiError,
  generateScriptWithGemini,
} from '../src/providers/gemini-api';
import {
  computeJobProgress,
  estimateScriptGenerationSec,
  formatElapsedTime,
  formatRemainingTime,
} from '../src/shared/progress-utils';
import { DEFAULT_SETTINGS, type FeedItem } from '../src/shared/types';

function makeMockResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('Gemini API retry, timeout, and fallback resilience', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 503 and succeeds when the server recovers', async () => {
    const progressMsgs: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeMockResponse(503, 'high demand'))
      .mockResolvedValueOnce(makeMockResponse(200, JSON.stringify({ ok: true })));

    const res = await fetchGeminiWithRetry(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
      { method: 'POST' },
      {
        maxRetries: 2,
        baseDelayMs: 5,
        timeoutMs: 2000,
        context: 'Gemini台本生成',
        onProgress: (msg) => progressMsgs.push(msg),
      }
    );

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progressMsgs.some((m) => m.includes('503'))).toBe(true);
  });

  it('does not retry on 401 and returns a friendly Japanese API key error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeMockResponse(401, 'invalid api key'));

    await expect(
      fetchGeminiWithRetry(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { method: 'POST' },
        { maxRetries: 2, baseDelayMs: 5, context: 'Gemini台本生成' }
      )
    ).rejects.toThrow('Gemini APIキーが無効か権限がありません');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts and reports a Japanese timeout message when request exceeds timeoutMs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(
      fetchGeminiWithRetry(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { method: 'POST' },
        { maxRetries: 0, timeoutMs: 25, baseDelayMs: 5, context: 'Gemini台本生成' }
      )
    ).rejects.toThrow('タイムアウト');
  });

  it('falls back to gemini-2.5-flash when primary model persistently returns 503', async () => {
    const calledUrls: string[] = [];
    const validScript = JSON.stringify({
      title: 'テスト番組',
      subtitle: '仏壇コラム解説',
      chapters: [
        {
          title: '仏壇処分のポイント',
          summary: '仏壇を処分する際の注意点',
          sourceIndices: [0],
          turns: [
            { speaker: 'HostA', text: 'こんにちは、今日は仏壇の処分方法について見ていきましょう。' },
            { speaker: 'HostB', text: 'はい、閉眼供養などの手順が大切ですよね。' },
          ],
        },
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = String(url);
      calledUrls.push(urlStr);
      if (urlStr.includes('gemini-flash-latest')) {
        return makeMockResponse(503, 'This model is currently experiencing high demand.');
      }
      return makeMockResponse(
        200,
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: validScript }] } }],
        })
      );
    });

    const items: FeedItem[] = [
      {
        id: 'item-1',
        source: 'generic',
        url: 'https://beprice.jp/fuyohin/butsudankuyou/column/butsudan-shobun',
        canonicalUrl: 'https://beprice.jp/fuyohin/butsudankuyou/column/butsudan-shobun',
        title: '仏壇の処分方法',
        author: 'beprice',
        content: '仏壇を処分する際の閉眼供養や依頼先について解説しています。',
        excerpt: '仏壇を処分する際の閉眼供養や依頼先について解説しています。',
        outboundUrls: [],
        publishedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
        engagementScore: 10,
        consumedInEpisodeId: null,
      },
    ];

    const progressMsgs: string[] = [];
    const result = await generateScriptWithGemini(
      items,
      { ...DEFAULT_SETTINGS, geminiApiKey: 'test-key', geminiModel: 'gemini-flash-latest' },
      undefined,
      {
        maxRetries: 1,
        baseDelayMs: 5,
        timeoutMs: 2000,
        onProgress: (m) => progressMsgs.push(m),
      }
    );

    expect(result.title).toBe('テスト番組');
    expect(result.chapters.length).toBeGreaterThan(0);
    expect(calledUrls.some((u) => u.includes('gemini-flash-latest'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('gemini-2.5-flash'))).toBe(true);
    expect(progressMsgs.some((m) => m.includes('代替モデル'))).toBe(true);
  });

  it('formats friendly 503 and 429 messages', () => {
    expect(formatFriendlyGeminiError(503, 'high demand', 'Gemini台本生成')).toContain('混雑');
    expect(formatFriendlyGeminiError(429, 'quota', 'Gemini台本生成')).toContain('利用上限');
  });
});

describe('Progress percentage, ETA, and SidePanelScope defaults', () => {
  it('computes monotonic progress percentages across phases', () => {
    const patrol0 = computeJobProgress('patrol', { current: 0, total: 4 });
    const patrol2 = computeJobProgress('patrol', { current: 2, total: 4 });
    const script = computeJobProgress('script', {
      hasCloudTts: true,
      estimatedScriptSec: 20,
      avgChapterTtsSec: 12,
    });
    const tts0 = computeJobProgress('tts', { current: 0, total: 4, avgChapterTtsSec: 10 });
    const tts2 = computeJobProgress('tts', { current: 2, total: 4, avgChapterTtsSec: 10 });
    const done = computeJobProgress('done');

    expect(patrol0.percent).toBeLessThan(patrol2.percent);
    expect(patrol2.percent).toBeLessThan(script.percent);
    expect(script.percent).toBeLessThan(tts0.percent);
    expect(tts0.percent).toBeLessThan(tts2.percent);
    expect(tts2.percent).toBeLessThan(done.percent);
    expect(tts2.estimatedRemainingSec).toBe(20);
    expect(done.percent).toBe(100);
    expect(done.estimatedRemainingSec).toBe(0);
  });

  it('formats remaining time and elapsed time cleanly', () => {
    expect(formatRemainingTime(null)).toBe('');
    expect(formatRemainingTime(0)).toBe('');
    expect(formatRemainingTime(42)).toBe('残り約 42秒');
    expect(formatRemainingTime(95)).toBe('残り約 1分35秒');
    expect(formatRemainingTime(120)).toBe('残り約 2分');

    expect(formatElapsedTime(0)).toBe('0:00');
    expect(formatElapsedTime(9)).toBe('0:09');
    expect(formatElapsedTime(125)).toBe('2:05');
  });

  it('bounds script generation estimates sensibly', () => {
    expect(estimateScriptGenerationSec(1, 3)).toBeGreaterThanOrEqual(15);
    expect(estimateScriptGenerationSec(30, 30)).toBeLessThanOrEqual(90);
  });

  it('defaults sidePanelScope to window', () => {
    expect(DEFAULT_SETTINGS.sidePanelScope).toBe('window');
  });
});

import { JSDOM } from 'jsdom';
import {
  addFocusTopic,
  parseFocusTopics,
  removeFocusTopic,
  toggleFocusTopic,
} from '../src/shared/topic-utils';
import { extractFromDocument } from '../src/extractors';
import { buildPodcastScriptPrompt } from '../src/providers/prompt-builder';

describe('Focus topic tags, bookmark/list extraction, and 60-min long podcasts', () => {
  it('parses, adds, removes, and toggles focus topic tags cleanly', () => {
    expect(parseFocusTopics('AI・テクノロジー・開発トレンド')).toEqual([
      'AI',
      'テクノロジー',
      '開発トレンド',
    ]);
    expect(parseFocusTopics('AI, 医療、株 / AI')).toEqual(['AI', '医療', '株']);
    expect(addFocusTopic('AI・テクノロジー', '仏壇')).toBe('AI・テクノロジー・仏壇');
    expect(addFocusTopic('AI・テクノロジー', 'AI')).toBe('AI・テクノロジー');
    expect(removeFocusTopic('AI・テクノロジー・仏壇', 'テクノロジー')).toBe('AI・仏壇');
    expect(toggleFocusTopic('AI・テクノロジー', 'デザイン')).toBe('AI・テクノロジー・デザイン');
    expect(toggleFocusTopic('AI・テクノロジー', 'AI')).toBe('テクノロジー');
  });

  it('extracts videos from YouTube Watch Later / Liked Videos playlist cards (ytd-playlist-video-renderer)', () => {
    const dom = new JSDOM(`
      <html><body>
        <ytd-playlist-video-renderer>
          <a id="video-title" href="/watch?v=dQw4w9WgXcQ&list=WL" title="AIエージェント最新動向">AIエージェント最新動向</a>
          <ytd-channel-name><a href="/@techch">Tech Channel</a></ytd-channel-name>
        </ytd-playlist-video-renderer>
      </body></html>
    `);
    const res = extractFromDocument(dom.window.document, 'https://www.youtube.com/playlist?list=WL');
    expect(res.blocked).toBe(false);
    expect(res.candidates.length).toBe(1);
    expect(res.candidates[0].source).toBe('youtube');
    expect(res.candidates[0].title).toContain('AIエージェント最新動向');
  });

  it('extracts tweets from X.com Lists and Bookmarks pages', () => {
    const dom = new JSDOM(`
      <html><body>
        <article data-testid="tweet">
          <div data-testid="User-Name"><span>Alice</span><span>@alice_dev</span></div>
          <div data-testid="tweetText">Xのリストから最新のAIニュースを収集するテスト投稿です。</div>
          <a href="/alice_dev/status/1234567890"><time datetime="2026-11-27T00:00:00Z">1h</time></a>
        </article>
      </body></html>
    `);
    const listRes = extractFromDocument(dom.window.document, 'https://x.com/i/lists/9999999');
    expect(listRes.blocked).toBe(false);
    expect(listRes.candidates.length).toBe(1);
    expect(listRes.candidates[0].source).toBe('x');

    const bmRes = extractFromDocument(dom.window.document, 'https://x.com/i/bookmarks');
    expect(bmRes.blocked).toBe(false);
    expect(bmRes.candidates.length).toBe(1);
    expect(bmRes.candidates[0].source).toBe('x');
  });

  it('supports long episodes up to 60 minutes in buildPodcastScriptPrompt', () => {
    const item: FeedItem = {
      id: 'i1',
      source: 'generic',
      url: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      title: '長尺テスト記事',
      author: 'author',
      content: '詳細な解説本文です。',
      excerpt: '詳細な解説本文です。',
      outboundUrls: [],
      publishedAt: new Date().toISOString(),
      capturedAt: new Date().toISOString(),
      engagementScore: 5,
      consumedInEpisodeId: null,
    };
    const prompt = buildPodcastScriptPrompt([item], {
      ...DEFAULT_SETTINGS,
      durationMode: 'fixed',
      targetDurationMin: 60,
    });
    expect(prompt).toContain('60 分');
    expect(prompt).toContain('9〜14個');
  });
});
