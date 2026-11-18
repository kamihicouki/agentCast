import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

const PROMOTED_LABELS = new Set(['promoted', 'プロモーション', '広告', 'ad']);

function parseMetricCount(label: string | null): number {
  if (!label) return 0;
  const match = /([\d,.]+)\s*([kmb万])?/i.exec(label);
  if (!match) return 0;
  const base = parseFloat(match[1].replace(/,/g, ''));
  if (Number.isNaN(base)) return 0;
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') return base * 1_000;
  if (suffix === 'm') return base * 1_000_000;
  if (suffix === '万') return base * 10_000;
  return base;
}

function isPromotedTweet(article: Element): boolean {
  if (article.querySelector('[data-testid="placementTracking"]')) {
    // placementTracking wraps video/cards too, so check for explicit ad indicator text
    const spans = article.querySelectorAll('span');
    for (const span of spans) {
      const txt = (span.textContent || '').trim().toLowerCase();
      if (PROMOTED_LABELS.has(txt)) return true;
    }
  }
  const allSpans = article.querySelectorAll('div[dir="ltr"] > span, span');
  for (const span of allSpans) {
    const txt = (span.textContent || '').trim().toLowerCase();
    if (PROMOTED_LABELS.has(txt)) return true;
  }
  return false;
}

export function extractXTimeline(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const tweets = doc.querySelectorAll('article[data-testid="tweet"]');
  const results: ExtractedCandidate[] = [];

  for (const article of tweets) {
    if (isPromotedTweet(article)) continue;

    const textNodes = article.querySelectorAll('[data-testid="tweetText"]');
    if (textNodes.length === 0) continue;

    const mainText = (textNodes[0]?.textContent || '').trim();
    const quotedText = textNodes.length > 1 ? (textNodes[1]?.textContent || '').trim() : '';
    if (!mainText && !quotedText) continue;

    // Extract author & handle from User-Name block
    const userNameBox = article.querySelector('[data-testid="User-Name"]');
    let author = 'X User';
    let authorHandle: string | undefined;
    if (userNameBox) {
      const spans = Array.from(userNameBox.querySelectorAll('span'))
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean);
      const handleSpan = spans.find((s) => s.startsWith('@'));
      const displaySpan = spans.find((s) => !s.startsWith('@') && s !== '·' && s.length > 0);
      if (displaySpan) author = displaySpan;
      if (handleSpan) authorHandle = handleSpan;
    }

    // Status permalink & timestamp
    const timeEl = article.querySelector('time');
    const publishedAt = timeEl?.getAttribute('datetime') || undefined;
    const statusAnchor =
      timeEl?.closest('a[href*="/status/"]') ||
      article.querySelector('a[href*="/status/"]');
    const statusHref = statusAnchor?.getAttribute('href');
    const tweetUrl = statusHref ? canonicalizeUrl(statusHref, 'https://x.com') : pageUrl;

    // Outbound links (cards & external links)
    const outboundUrls: string[] = [];
    for (const link of article.querySelectorAll('a[href^="http"]')) {
      const href = link.getAttribute('href');
      if (!href) continue;
      try {
        const u = new URL(href);
        if (u.hostname !== 'x.com' && u.hostname !== 'twitter.com') {
          outboundUrls.push(href);
        }
      } catch {
        // ignore invalid URL
      }
    }

    // Engagement score for ranking
    const likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    const rtBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    const likes = parseMetricCount(likeBtn?.getAttribute('aria-label') || likeBtn?.textContent || null);
    const rts = parseMetricCount(rtBtn?.getAttribute('aria-label') || rtBtn?.textContent || null);
    const engagementScore = 1 + Math.log10(1 + likes + rts * 2);

    const combinedBody = quotedText
      ? `${mainText}\n\n【引用ポスト】${quotedText}`
      : mainText;

    const firstLine = mainText.split('\n')[0]?.slice(0, 68) || 'ポスト';
    const title = `${author}${authorHandle ? ` (${authorHandle})` : ''}: ${firstLine}`;

    results.push({
      source: 'x',
      url: tweetUrl,
      title,
      author,
      authorHandle,
      content: combinedBody,
      outboundUrls: Array.from(new Set(outboundUrls)),
      publishedAt,
      engagementScore,
    });
  }

  return results;
}
