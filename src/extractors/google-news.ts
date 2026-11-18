import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

export function extractGoogleNews(doc: Document, _pageUrl: string): ExtractedCandidate[] {
  const results: ExtractedCandidate[] = [];
  const seenUrls = new Set<string>();

  // Google News renders personalized stories inside <article> elements or c-wiz cards containing ./read/ or ./articles/ links
  const articles = doc.querySelectorAll('article');

  for (const article of articles) {
    const link = article.querySelector(
      'a[href*="./read/"], a[href*="/read/"], a[href*="./articles/"], a[href*="/articles/"]'
    );
    const rawHref = link?.getAttribute('href');
    if (!rawHref) continue;

    const normalizedHref = rawHref.startsWith('./') ? rawHref.slice(1) : rawHref;
    const fullUrl = canonicalizeUrl(normalizedHref, 'https://news.google.com');
    if (seenUrls.has(fullUrl)) continue;

    // Headline sits in h3 / h4 / a[aria-label] or the primary anchor text
    const headingEl =
      article.querySelector('h3, h4') ||
      Array.from(article.querySelectorAll('a')).find(
        (a) => (a.textContent || '').trim().length >= 12
      );

    const headline = (
      headingEl?.textContent ||
      link?.getAttribute('aria-label') ||
      link?.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (headline.length < 10) continue;
    seenUrls.add(fullUrl);

    // Publisher badge (usually a compact div/span before <time>)
    const publisher =
      article
        .querySelector('[data-n-tid], .vr1PYe, .wEwyrc')
        ?.textContent?.trim() || 'Google News';

    const publishedAt =
      article.querySelector('time')?.getAttribute('datetime') || undefined;

    // Check if parent container holds related sub-coverage headlines
    const parentCluster = article.parentElement;
    const relatedHeadlines: string[] = [];
    if (parentCluster) {
      for (const siblingHeading of parentCluster.querySelectorAll('article h4')) {
        const subTxt = (siblingHeading.textContent || '').replace(/\s+/g, ' ').trim();
        if (subTxt && subTxt !== headline && subTxt.length >= 10) {
          relatedHeadlines.push(`・関連報道: ${subTxt}`);
        }
      }
    }

    const contentLines = [`【${publisher}】${headline}`, ...relatedHeadlines.slice(0, 3)];

    results.push({
      source: 'google_news',
      url: fullUrl,
      title: headline,
      author: publisher,
      content: contentLines.join('\n'),
      outboundUrls: [],
      publishedAt,
      engagementScore: 2.0 + Math.min(relatedHeadlines.length * 0.2, 0.8),
      needsFullArticleFetch: false,
    });
  }

  return results.slice(0, 24);
}
