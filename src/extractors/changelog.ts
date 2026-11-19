import type { ExtractedCandidate } from '../shared/types';
import { canonicalizeUrl } from '../shared/url-utils';

/**
 * Detects Changelog / Release Notes pages (e.g., https://antigravity.google/docs/changelog, GitHub Releases, etc.)
 * where hundreds of <article> / <details> blocks exist on a single multi-megabyte DOM.
 */
export function isChangelogPage(doc: Document, pageUrl: string): boolean {
  try {
    const parsed = new URL(pageUrl);
    const pathLower = parsed.pathname.toLowerCase();
    if (
      pathLower.includes('/changelog') ||
      pathLower.includes('/release-notes') ||
      pathLower.includes('/releases')
    ) {
      return true;
    }
    return doc.querySelectorAll('article.release-entry, .rn-panel.active article').length >= 2;
  } catch {
    return false;
  }
}

function summarizeDetailsSections(entry: Element): string[] {
  const sections: string[] = [];
  const detailsEls = Array.from(entry.querySelectorAll('details'));

  for (const details of detailsEls) {
    const summaryLabel = (details.querySelector('summary')?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    const bullets = Array.from(details.querySelectorAll('li, p'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 16 && t !== summaryLabel);

    if (bullets.length === 0) continue;

    // Prioritize top 6 highlights for Improvements and top 3 for Fixes so podcast audio stays crisp & engaging
    const isFixes = /fix/i.test(summaryLabel);
    const limit = isFixes ? 3 : 6;
    const picked = bullets.slice(0, limit).map((b) => `・${b.slice(0, 260)}`);

    sections.push(
      `${summaryLabel || '詳細'}（全${bullets.length}件中 上位${picked.length}件）:\n${picked.join('\n')}`
    );
  }

  return sections;
}

export function extractChangelog(doc: Document, pageUrl: string): ExtractedCandidate[] {
  const parsed = new URL(pageUrl);
  const siteName =
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    parsed.hostname;

  // Prefer the currently visible active tab panel (e.g. Antigravity App / CLI / SDK / IDE)
  const activePanel =
    doc.querySelector('.rn-panel.active') ||
    doc.querySelector('[role="tabpanel"].active') ||
    doc.querySelector('main') ||
    doc.body;

  const surfaceHeading =
    activePanel.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim() || '';

  const entryNodes = Array.from(
    activePanel.querySelectorAll('article.release-entry, article, section[id*="v"]')
  ).filter((el) => (el.textContent || '').trim().length >= 40);

  if (entryNodes.length === 0) {
    return [];
  }

  const results: ExtractedCandidate[] = [];
  const maxEntries = 6; // Keep the freshest 6 releases so the episode focuses on recent updates

  for (const entry of entryNodes.slice(0, maxEntries)) {
    const headings = Array.from(entry.querySelectorAll('h2, h3, h4'))
      .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const versionHeading = headings[0] || '最新リリース';
    const releaseTitle = headings[1] || '';

    const timeEl = entry.querySelector('time');
    const publishedAt =
      timeEl?.getAttribute('datetime') ||
      entry.querySelector('[class*="date"], .rn-date')?.textContent?.trim() ||
      undefined;

    // Collect top-level lead paragraphs (excluding paragraphs nested inside <details>)
    const leadParagraphs = Array.from(entry.querySelectorAll('p'))
      .filter((p) => !p.closest('details'))
      .map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 20);

    const detailsBlocks = summarizeDetailsSections(entry);

    const anchorId = entry.getAttribute('id') || entry.querySelector('[id]')?.getAttribute('id') || '';
    const entryUrl = anchorId
      ? canonicalizeUrl(`${parsed.origin}${parsed.pathname}#${anchorId}`)
      : canonicalizeUrl(pageUrl);

    const fullTitle = [surfaceHeading ? `[${surfaceHeading}]` : '', versionHeading, releaseTitle]
      .filter(Boolean)
      .join(' ')
      .slice(0, 120);

    const bodyParts = [
      publishedAt ? `リリース日: ${publishedAt}` : '',
      leadParagraphs.length > 0 ? `概要:\n${leadParagraphs.join('\n')}` : '',
      ...detailsBlocks,
    ].filter(Boolean);

    const content =
      bodyParts.join('\n\n').slice(0, 3200) ||
      (entry.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2200);

    if (content.length < 30) continue;

    results.push({
      source: 'generic',
      url: entryUrl,
      title: fullTitle,
      author: surfaceHeading ? `${siteName} (${surfaceHeading})` : siteName,
      content,
      outboundUrls: [],
      publishedAt,
      engagementScore: 3.0 - results.length * 0.15,
    });
  }

  return results;
}
