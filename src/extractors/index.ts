import type { ExtractionResultPayload } from '../shared/messages';
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

export function extractFromDocument(doc: Document, pageUrl: string): ExtractionResultPayload {
  const guard = checkPageAccessGuard(doc, pageUrl);
  if (guard.blocked) {
    return {
      blocked: true,
      blockReason: guard.reason,
      blockMessage: guard.message,
      candidates: [],
    };
  }

  const source = detectSourceFromUrl(pageUrl);
  let candidates: ExtractedCandidate[] = [];

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
};
