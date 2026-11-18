import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

/**
 * Summarizes code blocks into concise spoken cues so TTS does not read punctuation soup aloud.
 */
function extractReadableTechBody(container: Element): string {
  const clone = container.cloneNode(true) as Element;

  for (const pre of clone.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const classAttr = code?.getAttribute('class') || pre.getAttribute('class') || '';
    const langMatch = /language-([a-z0-9+#-]+)/i.exec(classAttr);
    const lang = langMatch ? langMatch[1] : 'コード';
    const firstNonEmptyLine = (pre.textContent || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

    const replacement = clone.ownerDocument.createElement('p');
    replacement.textContent = firstNonEmptyLine
      ? `（${lang}の実装コード例: ${firstNonEmptyLine.slice(0, 60)}）`
      : `（${lang}のコードスニペット）`;
    pre.replaceWith(replacement);
  }

  const blocks = Array.from(clone.querySelectorAll('h1, h2, h3, p, li, blockquote'))
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);

  return blocks.join('\n').slice(0, 8000);
}

export function extractZenn(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const parsed = new URL(pageUrl);

  // Case 1: Individual Zenn article or scrap (/articles/... or /scraps/...)
  if (/\/(articles|scraps)\/[a-z0-9_-]+/i.test(parsed.pathname)) {
    const title =
      doc.querySelector('article h1, h1')?.textContent?.trim() ||
      doc.title.replace(/\s*\|\s*Zenn$/i, '').trim();

    const author =
      doc.querySelector('header a[href^="/"], [class*="Author"] a')?.textContent?.trim() ||
      parsed.pathname.split('/').filter(Boolean)[0] ||
      'Zenn Author';

    const contentRoot = doc.querySelector('.znc, article') || doc.body;
    const content = extractReadableTechBody(contentRoot);
    if (content.length < 30) return [];

    return [
      {
        source: 'zenn',
        url: canonicalizeUrl(pageUrl),
        title,
        author,
        content,
        outboundUrls: [],
        publishedAt: doc.querySelector('time')?.getAttribute('datetime') || undefined,
        engagementScore: 2.4,
      },
    ];
  }

  // Case 2: Zenn Home / Trends / Following feed
  const results: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  const links = doc.querySelectorAll('a[href*="/articles/"], a[href*="/scraps/"]');

  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const fullUrl = canonicalizeUrl(href, 'https://zenn.dev');
    if (seen.has(fullUrl)) continue;

    const card = link.closest('article, [class*="ArticleList"], li, div') || link;
    const title =
      card.querySelector('h2, h3, [class*="title"]')?.textContent?.trim() ||
      link.textContent?.trim() ||
      '';

    if (title.length < 8) continue;
    seen.add(fullUrl);

    const author =
      card.querySelector('a[href^="/"]:not([href*="/articles/"])')?.textContent?.trim() ||
      'Zenn';

    results.push({
      source: 'zenn',
      url: fullUrl,
      title,
      author,
      content: title,
      outboundUrls: [],
      publishedAt: card.querySelector('time')?.getAttribute('datetime') || undefined,
      engagementScore: 2.0,
      needsFullArticleFetch: true,
    });
  }

  return results;
}

/**
 * Lightweight RSS parser for https://zenn.dev/feed (usable directly in Service Worker without opening a tab).
 */
export function parseZennRssXml(xmlText: string): ExtractedCandidate[] {
  const items: ExtractedCandidate[] = [];
  const itemBlocks = xmlText.match(/<item>[\s\S]*?<\/item>/gi) || [];

  const readTag = (block: string, tag: string): string => {
    const match = new RegExp(
      `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`,
      'i'
    ).exec(block);
    if (!match) return '';
    return (match[1] ?? match[2] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  };

  for (const block of itemBlocks.slice(0, 15)) {
    const title = readTag(block, 'title');
    const link = readTag(block, 'link');
    const description = readTag(block, 'description');
    const creator = readTag(block, 'dc:creator') || 'Zenn';
    const pubDate = readTag(block, 'pubDate');
    if (!title || !link) continue;

    items.push({
      source: 'zenn',
      url: canonicalizeUrl(link),
      title,
      author: creator,
      content: description ? `${title}\n${description}` : title,
      outboundUrls: [],
      publishedAt: pubDate ? new Date(pubDate).toISOString() : undefined,
      engagementScore: 2.1,
      needsFullArticleFetch: description.length < 220,
    });
  }

  return items;
}
