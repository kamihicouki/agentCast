import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

export function extractYahooNews(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const parsed = new URL(pageUrl);

  // Case 1: Full Yahoo! News article (/articles/<id>)
  if (/^\/articles\/[a-z0-9]+/i.test(parsed.pathname)) {
    const title =
      doc.querySelector('article h1, #uamods h1, h1')?.textContent?.trim() ||
      doc.title.replace(/\s*-\s*Yahoo!ニュース.*$/i, '').trim();

    const mediaName =
      doc.querySelector('article footer a, [class*="media"] a, [data-ual*="media"]')?.textContent?.trim() ||
      'Yahoo!ニュース';

    const articleRoot = doc.querySelector('#uamods, article') || doc.body;
    const paragraphs = Array.from(articleRoot.querySelectorAll('p'))
      .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(
        (txt) =>
          txt.length >= 15 &&
          !txt.includes('JavaScriptの設定を有効') &&
          !txt.startsWith('【関連記事】')
      );

    const content = paragraphs.join('\n').slice(0, 8000);
    if (content.length < 30) return [];

    return [
      {
        source: 'yahoo_news',
        url: canonicalizeUrl(pageUrl),
        title,
        author: mediaName,
        content,
        outboundUrls: [],
        publishedAt: doc.querySelector('time')?.getAttribute('datetime') || undefined,
        engagementScore: 2.3,
      },
    ];
  }

  // Case 2: Yahoo! News Pickup page (/pickup/<id>)
  if (/^\/pickup\/\d+/i.test(parsed.pathname)) {
    const title =
      doc.querySelector('[data-ual-view-type="digest"] h1, article h1, h1')?.textContent?.trim() ||
      doc.title.replace(/\s*-\s*Yahoo!ニュース.*$/i, '').trim();

    const fullArticleLink =
      doc.querySelector('a[href*="news.yahoo.co.jp/articles/"]')?.getAttribute('href') || undefined;

    const summaryText =
      Array.from(doc.querySelectorAll('article p, [data-ual-view-type="digest"] p'))
        .map((p) => (p.textContent || '').trim())
        .filter((t) => t.length >= 15)
        .join('\n') || title;

    return [
      {
        source: 'yahoo_news',
        url: fullArticleLink ? canonicalizeUrl(fullArticleLink) : canonicalizeUrl(pageUrl),
        title,
        author: 'Yahoo!ニュース トピックス',
        content: summaryText,
        outboundUrls: fullArticleLink ? [fullArticleLink] : [],
        engagementScore: 2.2,
        needsFullArticleFetch: Boolean(fullArticleLink),
      },
    ];
  }

  // Case 3: Yahoo! News Top / Topics / My News listing
  const results: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  const anchors = doc.querySelectorAll(
    'a[href*="/pickup/"], a[href*="news.yahoo.co.jp/articles/"], a[href^="/articles/"]'
  );

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    const fullUrl = canonicalizeUrl(href, 'https://news.yahoo.co.jp');
    if (seen.has(fullUrl)) continue;

    const headline = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (headline.length < 8 || headline === '記事全文を読む' || headline === 'もっと見る') {
      continue;
    }
    seen.add(fullUrl);

    results.push({
      source: 'yahoo_news',
      url: fullUrl,
      title: headline,
      author: 'Yahoo!ニュース',
      content: headline,
      outboundUrls: [],
      engagementScore: fullUrl.includes('/pickup/') ? 2.4 : 1.9,
      needsFullArticleFetch: true,
    });
  }

  return results.slice(0, 20);
}
