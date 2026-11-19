import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  extractFromDocument,
  extractGoogleNews,
  extractNote,
  extractXTimeline,
  extractYahooNews,
  extractZenn,
} from '../src/extractors';
import { parseZennRssXml } from '../src/extractors/zenn';
import {
  ensurePlayableAudioBlob,
  isRiffWav,
  mergeAudioBlobs,
  wrapPcm16ToWav,
} from '../src/shared/wav-utils';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { createDemoEpisode, parseGeneratedScriptJson } from '../src/providers/prompt-builder';
import { formatEpisodeAsMarkdown } from '../src/shared/export-utils';

function docFromHtml(html: string, url: string): Document {
  return new JSDOM(html, { url }).window.document;
}

describe('Site Extractors & Safety Guards', () => {
  it('extracts organic X.com tweets and filters out Promoted ads', () => {
    const doc = docFromHtml(
      `
      <main>
        <article data-testid="tweet">
          <div data-testid="User-Name">
            <span>山田 太郎</span>
            <span>@taro_dev</span>
          </div>
          <a href="/taro_dev/status/1900000001"><time datetime="2026-11-18T01:00:00.000Z"></time></a>
          <div data-testid="tweetText">Chrome MV3のOffscreen AudioとMediaSessionを組み合わせるとAirPods操作が快適すぎる！</div>
          <a href="https://zenn.dev/taro/articles/mv3-audio">カードリンク</a>
          <button data-testid="like" aria-label="120 Likes"></button>
        </article>
        <article data-testid="tweet">
          <div data-testid="User-Name"><span>Ad Brand</span><span>@adbrand</span></div>
          <div data-testid="placementTracking"><span>プロモーション</span></div>
          <div data-testid="tweetText">今すぐキャンペーンに申し込もう！</div>
        </article>
      </main>
    `,
      'https://x.com/home'
    );

    const items = extractXTimeline(doc, 'https://x.com/home');
    expect(items).toHaveLength(1);
    expect(items[0].author).toBe('山田 太郎');
    expect(items[0].authorHandle).toBe('@taro_dev');
    expect(items[0].url).toBe('https://x.com/taro_dev/status/1900000001');
    expect(items[0].outboundUrls).toContain('https://zenn.dev/taro/articles/mv3-audio');
  });

  it('extracts Note article body cleanly', () => {
    const doc = docFromHtml(
      `
      <article>
        <h1 class="o-noteContentHeader__title">個人開発で毎日聴くAIラジオを作った話</h1>
        <div class="o-noteContentHeader__name"><a href="/creator_x">佐藤 クリエイター</a></div>
        <div class="note-common-styles__textnote-body">
          <p>毎朝SNSやニュースサイトを巡回する時間を減らすため、ブラウザ拡張機能で音声番組化する仕組みを試しました。</p>
          <p>自分のログインセッションをそのまま活かせるのが最大のメリットです。</p>
        </div>
      </article>
    `,
      'https://note.com/creator_x/n/n1234567890ab'
    );

    const items = extractNote(doc, 'https://note.com/creator_x/n/n1234567890ab');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('個人開発で毎日聴くAIラジオを作った話');
    expect(items[0].content).toContain('自分のログインセッションをそのまま活かせる');
  });

  it('summarizes code blocks in Zenn articles and parses Zenn RSS', () => {
    const doc = docFromHtml(
      `
      <article>
        <h1>TypeScript 5.9の新機能まとめ</h1>
        <div class="znc">
          <p>今回のアップデートでは型推論とビルド体験がさらに改善されました。</p>
          <pre><code class="language-typescript">const greeting: string = "Hello agentCast";\nconsole.log(greeting);</code></pre>
        </div>
      </article>
    `,
      'https://zenn.dev/alice/articles/ts-59-update'
    );

    const items = extractZenn(doc, 'https://zenn.dev/alice/articles/ts-59-update');
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain('typescriptの実装コード例');
    expect(items[0].content).not.toContain('console.log(greeting)');

    const rssItems = parseZennRssXml(`
      <?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <item>
          <title><![CDATA[Viteによる高速Chrome拡張ビルド手法]]></title>
          <link>https://zenn.dev/bob/articles/vite-mv3-fast</link>
          <description><![CDATA[Manifest V3でホットリロードを実現する実践ガイド]]></description>
          <dc:creator>Bob</dc:creator>
        </item>
      </channel></rss>
    `);
    expect(rssItems).toHaveLength(1);
    expect(rssItems[0].title).toBe('Viteによる高速Chrome拡張ビルド手法');
    expect(rssItems[0].author).toBe('Bob');
  });

  it('resolves Yahoo! News pickup links to full article URLs', () => {
    const doc = docFromHtml(
      `
      <article data-ual-view-type="digest">
        <h1>次世代Bluetoothオーディオ規格が発表</h1>
        <p>低遅延と高音質を両立する新プロファイルが来春より順次搭載される見通しとなった。</p>
        <a href="https://news.yahoo.co.jp/articles/abcdef0123456789?utm_source=rss">記事全文を読む</a>
      </article>
    `,
      'https://news.yahoo.co.jp/pickup/6500001'
    );

    const items = extractYahooNews(doc, 'https://news.yahoo.co.jp/pickup/6500001');
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://news.yahoo.co.jp/articles/abcdef0123456789');
    expect(items[0].needsFullArticleFetch).toBe(true);
  });

  it('extracts Google News personalized story clusters', () => {
    const doc = docFromHtml(
      `
      <div>
        <article>
          <div class="vr1PYe">ITmedia NEWS</div>
          <h3><a href="./read/CBMiUkFVX3lxTE5?hl=ja">ブラウザ内蔵AIとマルチスピーカー音声合成の進化が加速</a></h3>
          <time datetime="2026-11-18T02:00:00Z"></time>
        </article>
      </div>
    `,
      'https://news.google.com/home?hl=ja'
    );

    const items = extractGoogleNews(doc, 'https://news.google.com/home?hl=ja');
    expect(items).toHaveLength(1);
    expect(items[0].author).toBe('ITmedia NEWS');
    expect(items[0].url).toContain('https://news.google.com/read/CBMiUkFVX3lxTE5');
  });

  it('halts immediately when login redirect or CAPTCHA is detected', () => {
    const loginDoc = docFromHtml('<html><body>Sign in</body></html>', 'https://x.com/i/flow/login');
    const loginRes = extractFromDocument(loginDoc, 'https://x.com/i/flow/login');
    expect(loginRes.blocked).toBe(true);
    expect(loginRes.blockReason).toBe('auth_required');

    const captchaDoc = docFromHtml(
      '<html><head><title>Just a moment...</title></head><body><iframe src="https://challenges.cloudflare.com/turnstile"></iframe></body></html>',
      'https://note.com/some-page'
    );
    const captchaRes = extractFromDocument(captchaDoc, 'https://note.com/some-page');
    expect(captchaRes.blocked).toBe(true);
    expect(captchaRes.blockReason).toBe('captcha_detected');
  });
});

describe('Audio WAV Wrapping & Script JSON Parsing', () => {
  it('wraps raw 24kHz 16-bit PCM into valid RIFF WAV without double-wrapping existing WAV', () => {
    // 1 second of 24kHz 16-bit mono silence = 48,000 bytes
    const rawPcm = new Uint8Array(48000);
    expect(isRiffWav(rawPcm)).toBe(false);

    const wrapped = wrapPcm16ToWav(rawPcm, 24000, 1, 16);
    expect(isRiffWav(wrapped)).toBe(true);
    expect(wrapped.byteLength).toBe(48044);

    const firstPass = ensurePlayableAudioBlob(rawPcm, 'audio/L16;codec=pcm;rate=24000');
    expect(firstPass.mimeType).toBe('audio/wav');
    expect(firstPass.durationSec).toBe(1);

    // Passing already-wrapped RIFF WAV (Gemini 3.8 TTS unary output) keeps exact size
    const secondPass = ensurePlayableAudioBlob(wrapped, 'audio/wav');
    expect(secondPass.blob.size).toBe(48044);
    expect(secondPass.durationSec).toBe(1);
  });

  it('parses fenced JSON podcast scripts from Web LLM sessions cleanly', () => {
    const fencedResponse = `もちろんです！以下がJSON台本です。
\`\`\`json
{
  "title": "朝のテックダイジェスト",
  "subtitle": "MV3音声再生とTypeScript最新動向",
  "chapters": [
    {
      "title": "Chrome拡張でのながら聴き体験",
      "summary": "Offscreen APIの活用法",
      "sourceIds": ["zenn-1"],
      "turns": [
        { "speaker": "HostA", "text": "今日はMV3の実装を見ていきましょう。", "spokenText": "今日はエムブイスリーの実装を見ていきましょう。" },
        { "speaker": "HostB", "text": "バックグラウンドでも音が途切れないのは嬉しいですね！" }
      ]
    }
  ]
}
\`\`\``;

    const parsed = parseGeneratedScriptJson(
      fencedResponse,
      [
        {
          id: 'zenn-1',
          source: 'zenn',
          url: 'https://zenn.dev/example',
          canonicalUrl: 'https://zenn.dev/example',
          title: 'MV3 Audio Guide',
          author: 'Author',
          content: 'Body',
          excerpt: 'Body',
          outboundUrls: [],
          publishedAt: '2026-11-18T00:00:00Z',
          capturedAt: '2026-11-18T00:00:00Z',
          engagementScore: 2,
          consumedInEpisodeId: null,
        },
      ],
      DEFAULT_SETTINGS
    );

    expect(parsed.title).toBe('朝のテックダイジェスト');
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].sourceItems[0]?.url).toBe('https://zenn.dev/example');
    expect(parsed.chapters[0].turns[0]?.speakerName).toBe(DEFAULT_SETTINGS.hostAName);
  });

  it('extracts structured releases from active tabpanel on antigravity.google/docs/changelog', () => {
    const doc = docFromHtml(
      `
      <main>
        <div id="panel-hub" class="rn-panel active">
          <h2>Antigravity App</h2>
          <article id="rel-models-gemini-4-neon" class="rn-row release-entry">
            <h3>Gemini 4 Neon</h3>
            <p>Gemini 4 Neon is now available on Google AI Ultra and Google AI Pro with four thinking levels.</p>
          </article>
          <article id="rel-hub-2.33.0" class="rn-row release-entry">
            <h3>v2.33.0</h3>
            <h3>Connect over SSH and GitHub pull request integration</h3>
            <p>This release adds SSH host connections for running projects and agents on remote Linux machines.</p>
            <details>
              <summary>Improvements (16)</summary>
              <ul>
                <li>You can now connect the Antigravity App to a remote 64-bit Linux machine over SSH.</li>
                <li>GitHub pull request links in chat now render as live status pills.</li>
              </ul>
            </details>
          </article>
        </div>
        <div id="panel-cli" class="rn-panel">
          <h2>Antigravity CLI</h2>
          <article id="rel-cli-1.0.0" class="rn-row release-entry">
            <h3>v1.0.0</h3>
            <p>Inactive tab panel content that should not leak into active extraction.</p>
          </article>
        </div>
      </main>
    `,
      'https://antigravity.google/docs/changelog'
    );

    const res = extractFromDocument(doc, 'https://antigravity.google/docs/changelog');
    expect(res.blocked).toBe(false);
    expect(res.candidates).toHaveLength(2);
    expect(res.candidates[0].url).toBe(
      'https://antigravity.google/docs/changelog#rel-models-gemini-4-neon'
    );
    expect(res.candidates[1].url).toBe('https://antigravity.google/docs/changelog#rel-hub-2.33.0');
    expect(res.candidates[1].title).toContain('v2.33.0');
    expect(res.candidates[1].content).toContain('Improvements (16)');
    expect(res.candidates[1].content).toContain('remote 64-bit Linux machine over SSH');
  });

  it('merges multi-chapter WAV blobs with 0.6s silence pause and formats Markdown show notes', async () => {
    // 0.5s of 24kHz 16-bit mono PCM = 24,000 bytes per chapter
    const ch1 = ensurePlayableAudioBlob(new Uint8Array(24000), 'audio/L16;codec=pcm;rate=24000');
    const ch2 = ensurePlayableAudioBlob(new Uint8Array(24000), 'audio/L16;codec=pcm;rate=24000');

    const merged = await mergeAudioBlobs([
      { blob: ch1.blob, mimeType: ch1.mimeType },
      { blob: ch2.blob, mimeType: ch2.mimeType },
    ]);

    expect(merged.ext).toBe('wav');
    // 44 header + 24000 + (24000 * 0.6 * 2 = 28800 gap) + 24000 = 76844 bytes
    const bytes = new Uint8Array(await merged.blob.arrayBuffer());
    expect(isRiffWav(bytes)).toBe(true);
    expect(bytes.byteLength).toBe(44 + 24000 + 28800 + 24000);

    const demo = createDemoEpisode(DEFAULT_SETTINGS);
    const md = formatEpisodeAsMarkdown(demo);
    expect(md).toContain(`# ${demo.title}`);
    expect(md).toContain('### 参照リンク');
    expect(md).toContain('https://zenn.dev/');
  });
});
