import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl, makeExcerpt } from '../shared/url-utils';

/**
 * Extracts structured items from arbitrary web pages using a user-configured CSS selector.
 */
export function extractByCssSelector(
  doc: Document,
  pageUrl: string,
  cssSelector: string,
  siteName?: string
): ExtractedCandidate[] {
  const selector = cssSelector.trim();
  if (!selector) return [];

  let nodes: Element[] = [];
  try {
    nodes = Array.from(doc.querySelectorAll(selector));
  } catch {
    return [];
  }

  const authorFallback = siteName || new URL(pageUrl).hostname;
  const results: ExtractedCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < nodes.length && results.length < 18; i++) {
    const el = nodes[i];
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('script, style, noscript, svg').forEach((n) => n.remove());

    const headingEl = clone.querySelector('h1, h2, h3, h4, [class*="title"]');
    const linkEl = el.querySelector<HTMLAnchorElement>('a[href]');

    let itemUrl = pageUrl;
    if (linkEl?.getAttribute('href')) {
      try {
        itemUrl = canonicalizeUrl(new URL(linkEl.getAttribute('href')!, pageUrl).toString());
      } catch {
        itemUrl = pageUrl;
      }
    } else if (el.id) {
      const u = new URL(pageUrl);
      u.hash = el.id;
      itemUrl = u.toString();
    } else {
      const u = new URL(pageUrl);
      u.hash = `item-${i + 1}`;
      itemUrl = u.toString();
    }

    const rawText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (rawText.length < 24) continue;

    const title =
      (headingEl?.textContent || '').replace(/\s+/g, ' ').trim() ||
      (linkEl?.textContent || '').replace(/\s+/g, ' ').trim() ||
      makeExcerpt(rawText, 64);

    const dedupeKey = `${itemUrl}::${title.slice(0, 40)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const timeEl = el.querySelector('time');
    const publishedAt = timeEl?.getAttribute('datetime') || undefined;

    results.push({
      source: 'generic',
      url: itemUrl,
      title,
      author: authorFallback,
      content: rawText.slice(0, 2200),
      outboundUrls: itemUrl !== pageUrl ? [itemUrl] : [],
      publishedAt,
      engagementScore: Math.max(1, 5 - Math.floor(i / 4)),
    });
  }

  return results;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lightweight RSS 2.0 / Atom XML parser for user-added feed URLs (works inside Service Worker without DOMParser).
 */
export function parseGenericRssOrAtomXml(
  xml: string,
  siteName: string,
  feedUrl: string
): ExtractedCandidate[] {
  const results: ExtractedCandidate[] = [];

  // 1. RSS <item> blocks
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null && results.length < 15) {
    const block = match[1];
    const title = decodeXmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || '');
    const link = decodeXmlEntities(/<link[^>]*>([\s\S]*?)<\/link>/i.exec(block)?.[1] || '');
    const desc = decodeXmlEntities(
      /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i.exec(block)?.[1] ||
        /<description[^>]*>([\s\S]*?)<\/description>/i.exec(block)?.[1] ||
        ''
    );
    const author =
      decodeXmlEntities(
        /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(block)?.[1] ||
          /<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1] ||
          ''
      ) || siteName;
    const pubDate = decodeXmlEntities(
      /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1] || ''
    );

    if (!title && !desc) continue;
    const url = link ? canonicalizeUrl(link) : feedUrl;
    results.push({
      source: 'generic',
      url,
      title: title || makeExcerpt(desc, 64),
      author,
      content: (desc || title).slice(0, 2200),
      outboundUrls: link ? [url] : [],
      publishedAt: pubDate ? new Date(pubDate).toISOString() : undefined,
      engagementScore: 2,
    });
  }

  if (results.length > 0) return results;

  // 2. Atom <entry> blocks
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  while ((match = entryRegex.exec(xml)) !== null && results.length < 15) {
    const block = match[1];
    const title = decodeXmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || '');
    const hrefMatch =
      /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block) ||
      /<link[^>]*href=["']([^"']+)["']/i.exec(block);
    const link = hrefMatch?.[1] || '';
    const summary = decodeXmlEntities(
      /<content[^>]*>([\s\S]*?)<\/content>/i.exec(block)?.[1] ||
        /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(block)?.[1] ||
        ''
    );
    const author =
      decodeXmlEntities(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>/i.exec(block)?.[1] || '') ||
      siteName;
    const updated = decodeXmlEntities(
      /<published[^>]*>([\s\S]*?)<\/published>/i.exec(block)?.[1] ||
        /<updated[^>]*>([\s\S]*?)<\/updated>/i.exec(block)?.[1] ||
        ''
    );

    if (!title && !summary) continue;
    const url = link ? canonicalizeUrl(link) : feedUrl;
    results.push({
      source: 'generic',
      url,
      title: title || makeExcerpt(summary, 64),
      author,
      content: (summary || title).slice(0, 2200),
      outboundUrls: link ? [url] : [],
      publishedAt: updated || undefined,
      engagementScore: 2,
    });
  }

  return results;
}
