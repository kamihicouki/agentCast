import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

export function extractNote(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const parsedUrl = new URL(pageUrl);

  // Case 1: Individual Note article page (e.g. https://note.com/<user>/n/nxxxxxxxx)
  if (/\/n\/n[a-z0-9]+/i.test(parsedUrl.pathname)) {
    const title =
      doc.querySelector('h1.o-noteContentHeader__title, article h1, h1')?.textContent?.trim() ||
      doc.title.replace(/\｜note$/, '').trim();

    const author =
      doc
        .querySelector(
          '.o-noteContentHeader__name a, [data-testid="creator-name"], a[href^="/"][class*="creator"]'
        )
        ?.textContent?.trim() || 'noteクリエイター';

    const bodyContainer =
      doc.querySelector('.note-common-styles__textnote-body, .o-noteContentText, article') ||
      doc.body;

    const paragraphs = Array.from(bodyContainer.querySelectorAll('p, h2, h3, li, blockquote'))
      .map((el) => (el.textContent || '').trim())
      .filter((txt) => txt.length > 0);

    const content = paragraphs.join('\n').trim();
    if (content.length < 30) return [];

    const publishedAt =
      doc.querySelector('time')?.getAttribute('datetime') || undefined;

    return [
      {
        source: 'note',
        url: canonicalizeUrl(pageUrl),
        title,
        author,
        content: content.slice(0, 8000),
        outboundUrls: [],
        publishedAt,
        engagementScore: 2.5,
      },
    ];
  }

  // Case 2: Note Home / Following timeline / Topic listing
  const results: ExtractedCandidate[] = [];
  const seenUrls = new Set<string>();
  const noteLinks = doc.querySelectorAll('a[href*="/n/n"]');

  for (const anchor of noteLinks) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    const fullUrl = canonicalizeUrl(href, 'https://note.com');
    if (!/\/n\/n[a-z0-9]+/i.test(fullUrl) || seenUrls.has(fullUrl)) continue;

    const card =
      anchor.closest('article, .m-largeNoteWrapper, .o-timelineItem, [class*="noteItem"], li, div') ||
      anchor;

    const headingText =
      card.querySelector('h2, h3, [class*="title"]')?.textContent?.trim() ||
      anchor.getAttribute('aria-label')?.trim() ||
      anchor.textContent?.trim() ||
      '';

    if (headingText.length < 8) continue;
    seenUrls.add(fullUrl);

    const excerpt =
      card.querySelector('p, [class*="description"], [class*="body"]')?.textContent?.trim() ||
      headingText;

    const author =
      card.querySelector('[class*="creator"], [class*="user"], [class*="name"]')?.textContent?.trim() ||
      'note';

    const timeAttr = card.querySelector('time')?.getAttribute('datetime') || undefined;

    results.push({
      source: 'note',
      url: fullUrl,
      title: headingText,
      author,
      content: `${headingText}\n${excerpt}`.trim(),
      outboundUrls: [],
      publishedAt: timeAttr,
      engagementScore: 1.8,
      needsFullArticleFetch: excerpt.length < 180,
    });
  }

  return results;
}
