import { Readability } from '@mozilla/readability';
import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl, detectSourceFromUrl } from '../shared/url-utils';

export function extractGenericReadability(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const clonedDoc = doc.cloneNode(true) as Document;
  const reader = new Readability(clonedDoc, {
    charThreshold: 120,
  });
  const parsed = reader.parse();

  if (!parsed || !parsed.textContent || parsed.textContent.trim().length < 80) {
    // Fallback to meta description + paragraphs if Readability returns null
    const fallbackTitle = doc.title?.trim() || '';
    const paragraphs = Array.from(doc.querySelectorAll('article p, main p, p'))
      .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 20)
      .slice(0, 30)
      .join('\n');

    if (paragraphs.length < 80) return [];

    return [
      {
        source: detectSourceFromUrl(pageUrl),
        url: canonicalizeUrl(pageUrl),
        title: fallbackTitle || paragraphs.slice(0, 60),
        author: new URL(pageUrl).hostname,
        content: paragraphs.slice(0, 8000),
        outboundUrls: [],
        engagementScore: 2.0,
      },
    ];
  }

  const cleanContent = parsed.textContent.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8500);
  return [
    {
      source: detectSourceFromUrl(pageUrl),
      url: canonicalizeUrl(pageUrl),
      title: parsed.title?.trim() || doc.title?.trim() || pageUrl,
      author: parsed.byline?.trim() || parsed.siteName?.trim() || new URL(pageUrl).hostname,
      content: cleanContent,
      outboundUrls: [],
      publishedAt: parsed.publishedTime || undefined,
      engagementScore: 2.2,
    },
  ];
}
