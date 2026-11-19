import type { CustomExtractRule, ExtractionResultPayload } from '../shared/messages';
import type { ExtractedCandidate } from '../shared/types';
import { detectSourceFromUrl } from '../shared/url-utils';
import { checkPageAccessGuard } from './login-guard';
import { extractXTimeline } from './x-timeline';
import { extractNote } from './note';
import { extractZenn } from './zenn';
import { extractYahooNews } from './yahoo-news';
import { extractGoogleNews } from './google-news';
import { extractChangelog, isChangelogPage } from './changelog';
import { extractGenericReadability } from './generic-readability';
import { extractByCssSelector, parseGenericRssOrAtomXml } from './custom-site';

export function extractFromDocument(
  doc: Document,
  pageUrl: string,
  customRule?: CustomExtractRule
): ExtractionResultPayload {
  const guard = checkPageAccessGuard(doc, pageUrl);
  if (guard.blocked) {
    return {
      blocked: true,
      blockReason: guard.reason,
      blockMessage: guard.message,
      candidates: [],
    };
  }

  let candidates: ExtractedCandidate[] = [];

  // Explicit custom extraction strategy override (from user-configured custom sites)
  if (customRule && customRule.strategy !== 'auto') {
    if (customRule.strategy === 'css_selector' && customRule.cssSelector) {
      candidates = extractByCssSelector(doc, pageUrl, customRule.cssSelector, customRule.siteName);
    } else if (customRule.strategy === 'changelog') {
      candidates = extractChangelog(doc, pageUrl);
    } else if (customRule.strategy === 'readability') {
      candidates = extractGenericReadability(doc, pageUrl);
    }

    if (candidates.length > 0) {
      return { blocked: false, candidates };
    }
  }

  const source = detectSourceFromUrl(pageUrl);

  if (source === 'generic' && isChangelogPage(doc, pageUrl)) {
    candidates = extractChangelog(doc, pageUrl);
  }

  if (candidates.length === 0) {
    switch (source) {
      case 'x':
        candidates = extractXTimeline(doc, pageUrl);
        break;
      case 'note':
        candidates = extractNote(doc, pageUrl);
        break;
      case 'zenn':
        candidates = extractZenn(doc, pageUrl);
        break;
      case 'yahoo_news':
        candidates = extractYahooNews(doc, pageUrl);
        break;
      case 'google_news':
        candidates = extractGoogleNews(doc, pageUrl);
        break;
      default:
        candidates = extractGenericReadability(doc, pageUrl);
        break;
    }
  }

  // Fallback to Readability if a specific site page didn't match timeline selectors
  if (candidates.length === 0 && source !== 'x' && source !== 'google_news') {
    candidates = extractGenericReadability(doc, pageUrl);
  }

  return {
    blocked: false,
    candidates,
  };
}

export {
  extractXTimeline,
  extractNote,
  extractZenn,
  extractYahooNews,
  extractGoogleNews,
  extractChangelog,
  extractGenericReadability,
  extractByCssSelector,
  parseGenericRssOrAtomXml,
};
