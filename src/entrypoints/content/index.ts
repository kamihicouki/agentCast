import { extractFromDocument } from '../../extractors';
import type {
  CustomExtractRule,
  ExtractionResultPayload,
  RuntimeRequest,
} from '../../shared/messages';
import type { ExtensionSettings } from '../../shared/types';

const SETTINGS_STORAGE_KEY = 'agentcast_settings_v1';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isPassiveCaptureEnabledInStorage(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  return (stored as Partial<ExtensionSettings>).passiveCaptureEnabled === true;
}

async function gentleScrollAndExtract(
  scrollSteps = 0,
  customRule?: CustomExtractRule
): Promise<ExtractionResultPayload> {
  const firstPass = extractFromDocument(document, window.location.href, customRule);
  if (firstPass.blocked || scrollSteps <= 0) {
    return firstPass;
  }

  const mergedByUrl = new Map(firstPass.candidates.map((c) => [c.url, c]));
  const maxSteps = Math.min(scrollSteps, 4);

  for (let i = 0; i < maxSteps; i++) {
    const jitter = 650 + Math.floor(Math.random() * 450);
    window.scrollBy({ top: Math.round(window.innerHeight * 0.82), behavior: 'smooth' });
    await sleep(jitter);

    const pass = extractFromDocument(document, window.location.href, customRule);
    if (pass.blocked) {
      return pass;
    }
    for (const item of pass.candidates) {
      const prev = mergedByUrl.get(item.url);
      if (!prev || item.content.length > prev.content.length) {
        mergedByUrl.set(item.url, item);
      }
    }
  }

  return {
    blocked: false,
    candidates: Array.from(mergedByUrl.values()),
  };
}

// Guard against duplicate listener registration when injected on demand
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  const win = window as Window & { __agentCastContentReady__?: boolean };
  if (!win.__agentCastContentReady__) {
    win.__agentCastContentReady__ = true;

  // Always respond to explicit user-triggered extraction requests (patrol / tab group / active tab)
  chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
    if (message?.type === 'CONTENT_EXTRACT_NOW') {
      void gentleScrollAndExtract(message.scrollSteps ?? 0, message.customRule).then(sendResponse);
      return true;
    }
    return false;
  });

  // Passive browsing capture: strictly gated behind explicit user opt-in (passiveCaptureEnabled === true).
  // When OFF (the default on fresh install), neither timers nor scroll listeners nor extractFromDocument run.
  let passiveActive = false;
  let debounceTimer: number | null = null;
  let initialTimer: number | null = null;
  const lastSentHashes = new Set<string>();

  const flushPassiveCapture = () => {
    if (!passiveActive) return;
    const res = extractFromDocument(document, window.location.href);
    if (res.blocked || res.candidates.length === 0) return;

    const fresh = res.candidates.filter((c) => {
      const key = `${c.url}::${c.content.length}`;
      if (lastSentHashes.has(key)) return false;
      lastSentHashes.add(key);
      return true;
    });

    if (fresh.length > 0) {
      chrome.runtime
        .sendMessage({
          type: 'PASSIVE_CANDIDATES',
          candidates: fresh.slice(0, 25),
          pageUrl: window.location.href,
        } satisfies RuntimeRequest)
        .catch(() => {
          // Service worker may be restarting; safe to ignore
        });
    }
  };

  const schedulePassiveCapture = () => {
    if (!passiveActive) return;
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(flushPassiveCapture, 1800);
  };

  const enablePassiveCapture = () => {
    if (passiveActive) return;
    passiveActive = true;
    window.addEventListener('scroll', schedulePassiveCapture, { passive: true });
    initialTimer = window.setTimeout(flushPassiveCapture, 2200);
  };

  const disablePassiveCapture = () => {
    if (!passiveActive) return;
    passiveActive = false;
    window.removeEventListener('scroll', schedulePassiveCapture);
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (initialTimer !== null) {
      window.clearTimeout(initialTimer);
      initialTimer = null;
    }
  };

  if (chrome.storage?.local) {
    chrome.storage.local
      .get(SETTINGS_STORAGE_KEY)
      .then((res) => {
        if (isPassiveCaptureEnabledInStorage(res?.[SETTINGS_STORAGE_KEY])) {
          enablePassiveCapture();
        }
      })
      .catch(() => {
        // Default OFF on storage read error
      });

    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SETTINGS_STORAGE_KEY]) return;
      if (isPassiveCaptureEnabledInStorage(changes[SETTINGS_STORAGE_KEY].newValue)) {
        enablePassiveCapture();
      } else {
        disablePassiveCapture();
      }
    });
  }
  }
}
