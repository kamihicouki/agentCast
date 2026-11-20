import {
  db,
  getSettings,
  getUnreadQueue,
  ingestCandidates,
  makeChapterKey,
  markItemsConsumed,
  saveSettings,
} from '../../storage/db';
import {
  INITIAL_PLAYBACK_STATE,
  PATROL_SOURCE_IDS,
  SOURCE_META,
  type CustomSiteConfig,
  type ExtractedCandidate,
  type ExtensionSettings,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type SourceId,
  type TabGroupSummary,
} from '../../shared/types';
import type {
  CustomExtractRule,
  ExtractionResultPayload,
  PendingPublishJob,
  RuntimeRequest,
} from '../../shared/messages';
import { parseZennRssXml } from '../../extractors/zenn';
import { parseGenericRssOrAtomXml } from '../../extractors/custom-site';
import {
  createDemoEpisode,
  filterFreshAndUniqueItems,
  type RecentTopicDigest,
} from '../../providers/prompt-builder';
import {
  generateScriptWithGemini,
  synthesizeChapterWithGeminiTts,
} from '../../providers/gemini-api';
import {
  generateScriptWithOpenAI,
  synthesizeChapterWithOpenAITts,
} from '../../providers/openai-api';
import { generateScriptViaWebSession } from '../../providers/personal-only/web-llm-bridge';
import {
  getDevBuildStatus,
  startDevAutoReloader,
} from '../../providers/personal-only/dev-reloader';
import {
  injectAiStudioKeyHelper,
  verifyGeminiApiKey,
} from '../../providers/personal-only/aistudio-key-helper';
import {
  injectXPublishHelper,
  injectYouTubePublishHelper,
} from '../../providers/personal-only/publish-helpers';
import { runPromptViaWebSession } from '../../providers/personal-only/web-llm-bridge';
import { generateTextWithGemini } from '../../providers/gemini-api';
import { generateTextWithOpenAI } from '../../providers/openai-api';
import { summarizeYouTubeVideo, type DigestLlmRunner } from '../../providers/video-digest';
import { extractYouTubeVideoId } from '../../extractors/youtube';
import {
  addWatchTarget,
  buildRadarCandidates,
  importXFollowing,
  importYouTubeSubscriptions,
  runRadarCheck,
  type RadarDeps,
} from './radar';

const ALARM_MORNING_CAST = 'agentcast_scheduled_generation';
const PATROL_GROUP_TITLE = 'agentCast 巡回中';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let latestPlaybackState: PlaybackState = { ...INITIAL_PLAYBACK_STATE };
let isJobRunning = false;
let currentJobMessage = '';
let lastJobError = '';
/** videoId → progress message for in-flight YouTube digests (not exclusive with patrol jobs). */
const digestInProgress = new Map<string, string>();

// Open Side Panel automatically when clicking the toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[agentCast] sidePanel.setPanelBehavior warning:', err));

// Guard Dev Auto-Reloader during BOTH audio playback AND active generation jobs!
startDevAutoReloader(
  () => latestPlaybackState.isPlaying || isJobRunning || digestInProgress.size > 0
);

/**
 * Marks any orphaned "generating_script / synthesizing_audio / collecting" episodes left behind
 * by a previous Service Worker restart or crash as failed so they don't clutter the dropdown forever.
 */
async function cleanupStaleEpisodes(deleteStale = false): Promise<number> {
  const all = await db.episodes.toArray();
  const now = Date.now();
  let affected = 0;

  for (const ep of all) {
    const isPending =
      ep.status === 'collecting' ||
      ep.status === 'generating_script' ||
      ep.status === 'synthesizing_audio';
    if (!isPending && !(deleteStale && ep.status === 'error')) continue;

    const lastTouch = Date.parse(ep.updatedAt || ep.createdAt) || 0;
    const isOrphaned = !isJobRunning && (deleteStale || now - lastTouch > 150_000);
    if (!isOrphaned) continue;

    if (deleteStale || ep.chapters.length === 0) {
      await deleteEpisodeById(ep.id);
    } else {
      await db.episodes.update(ep.id, {
        status: 'error',
        statusDetail: undefined,
        errorMessage: '前回の生成が途中で中断されました。',
        updatedAt: new Date().toISOString(),
      });
    }
    affected++;
  }

  if (affected > 0) {
    broadcastEvent({ type: 'EPISODES_UPDATED' });
  }
  return affected;
}

async function deleteEpisodeById(episodeId: string): Promise<void> {
  await db.transaction('rw', db.episodes, db.chapterAudio, async () => {
    await db.episodes.delete(episodeId);
    await db.chapterAudio.where('episodeId').equals(episodeId).delete();
  });
  broadcastEvent({ type: 'EPISODES_UPDATED' });
}

// Run orphan cleanup shortly after Service Worker startup
void cleanupStaleEpisodes(false);

chrome.runtime.onInstalled.addListener(async () => {
  await cleanupStaleEpisodes(true);
  const existingCount = await db.episodes.count();
  if (existingCount === 0) {
    const settings = await getSettings();
    const demo = createDemoEpisode(settings);
    await db.episodes.put(demo);
  }
  await syncDailyAlarm();
});

async function syncDailyAlarm(): Promise<void> {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_MORNING_CAST);
  if (!settings.autoScheduleEnabled) return;

  const [hh, mm] = (settings.autoScheduleTime || '07:30').split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(Number.isFinite(hh) ? hh : 7, Number.isFinite(mm) ? mm : 30, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  await chrome.alarms.create(ALARM_MORNING_CAST, {
    when: next.getTime(),
    periodInMinutes: 24 * 60,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_MORNING_CAST) {
    void runBackgroundJob('定時巡回＆番組編成を開始しました...', async () => {
      await patrolAndGenerateEpisode();
    });
  }
});

let creatingOffscreen: Promise<void> | null = null;
async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification:
        'Side Panelの開閉やタブ移動に依存せずポッドキャスト音声とMediaSession、長時間生成ジョブの安定動作を維持するため',
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

/**
 * Maintains an active Port to the Offscreen Document for the duration of a long-running job,
 * preventing Chrome MV3 from terminating the Service Worker after 30 seconds of idle time.
 */
async function withServiceWorkerKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  let port: chrome.runtime.Port | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await ensureOffscreenDocument();
    port = chrome.runtime.connect({ name: 'agentcast-keepalive' });
    pingTimer = setInterval(() => {
      try {
        port?.postMessage({ type: 'PING', ts: Date.now() });
      } catch {
        // Ignore if port already closed
      }
    }, 15_000);
    return await fn();
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    try {
      port?.disconnect();
    } catch {
      // Ignore
    }
  }
}

function broadcastEvent(payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function updateJobProgress(message: string): void {
  currentJobMessage = message;
  broadcastEvent({ type: 'PATROL_PROGRESS', message, isJobRunning });
}

async function runBackgroundJob(
  initialMessage: string,
  task: () => Promise<{ warnings?: string[] } | void>
): Promise<void> {
  if (isJobRunning) return;
  isJobRunning = true;
  lastJobError = '';
  updateJobProgress(initialMessage);

  try {
    const res = await withServiceWorkerKeepAlive(task);
    if (res && Array.isArray(res.warnings) && res.warnings.length > 0) {
      lastJobError = res.warnings.join(' / ');
      broadcastEvent({ type: 'JOB_WARNING', message: lastJobError });
    }
  } catch (err) {
    lastJobError = err instanceof Error ? err.message : String(err);
    broadcastEvent({ type: 'JOB_ERROR', message: lastJobError });
  } finally {
    isJobRunning = false;
    updateJobProgress('');
    broadcastEvent({ type: 'JOB_FINISHED', error: lastJobError });
  }
}

async function waitForTabReady(tabId: number, timeoutMs = 16000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return;
    }
    await sleep(350);
  }
}

// Automatically inject content.js on user-added custom sites with passiveEnabled
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url || !tab.url.startsWith('http')) return;
  void (async () => {
    const settings = await getSettings();
    if (!settings.passiveCaptureEnabled || !settings.customSites?.length) return;
    const matched = settings.customSites.find(
      (s) => s.enabled && s.passiveEnabled && s.extractionStrategy !== 'rss' && urlMatchesCustomSite(tab.url!, s.url)
    );
    if (!matched) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {
      // Restricted page or tab closed
    }
  })();
});

function urlMatchesCustomSite(tabUrl: string, siteUrl: string): boolean {
  try {
    const a = new URL(tabUrl);
    const b = new URL(siteUrl);
    if (a.hostname !== b.hostname) return false;
    const prefix = b.pathname.replace(/\/+$/, '');
    return !prefix || a.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

async function extractFromTab(
  tabId: number,
  scrollSteps = 0,
  customRule?: CustomExtractRule
): Promise<ExtractionResultPayload> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    // Content script might already be active or URL is restricted (chrome://)
  }

  const response = (await chrome.tabs
    .sendMessage(tabId, {
      type: 'CONTENT_EXTRACT_NOW',
      scrollSteps,
      customRule,
    } satisfies RuntimeRequest)
    .catch(() => null)) as ExtractionResultPayload | null;

  if (!response) {
    return {
      blocked: false,
      candidates: [],
    };
  }
  return response;
}

async function captureActiveTab(): Promise<{
  inserted: number;
  updated: number;
  items: FeedItem[];
  warning?: string;
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab?.id ||
    !tab.url ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://')
  ) {
    throw new Error('現在のタブは読み取り対象外のページ（Chrome内部ページ等）です。');
  }

  const res = await extractFromTab(tab.id, 0);
  if (res.blocked) {
    return { inserted: 0, updated: 0, items: [], warning: res.blockMessage };
  }

  const stored = await ingestCandidates(res.candidates);
  broadcastEvent({ type: 'QUEUE_UPDATED' });
  return { inserted: stored.inserted, updated: stored.updated, items: stored.items };
}

async function listUserTabGroups(): Promise<TabGroupSummary[]> {
  if (!chrome.tabGroups?.query) return [];
  const groups = await chrome.tabGroups.query({});
  const summaries: TabGroupSummary[] = [];

  for (const g of groups) {
    if (g.title === PATROL_GROUP_TITLE) continue;
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const readableTabs = tabs.filter(
      (t) =>
        t.url &&
        !t.url.startsWith('chrome://') &&
        !t.url.startsWith('chrome-extension://')
    );
    if (readableTabs.length === 0) continue;

    summaries.push({
      id: g.id,
      title: g.title || `無題グループ (${g.color})`,
      color: g.color,
      tabCount: readableTabs.length,
    });
  }

  return summaries;
}

async function patrolTabGroup(groupId: number): Promise<{
  inserted: number;
  items: FeedItem[];
  warnings: string[];
}> {
  const tabs = await chrome.tabs.query({ groupId });
  const readableTabs = tabs.filter(
    (t): t is chrome.tabs.Tab & { id: number; url: string } =>
      Boolean(t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
  );

  if (readableTabs.length === 0) {
    throw new Error('選択したタブグループに読み取り可能なWebページがありません。');
  }

  let totalInserted = 0;
  const collectedItems: FeedItem[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < readableTabs.length; i++) {
    const t = readableTabs[i];
    updateJobProgress(
      `タブグループ巡回中 (${i + 1}/${readableTabs.length}): ${(t.title || t.url).slice(0, 28)}…`
    );

    const extracted = await extractFromTab(t.id, 0);
    if (extracted.blocked) {
      warnings.push(`${t.title || t.url}: ${extracted.blockMessage || 'スキップ'}`);
      continue;
    }

    const saved = await ingestCandidates(extracted.candidates.slice(0, 12));
    totalInserted += saved.inserted;
    collectedItems.push(...saved.items);
    broadcastEvent({ type: 'QUEUE_UPDATED' });
  }

  return { inserted: totalInserted, items: collectedItems, warnings };
}

async function patrolSources(requestedSources?: SourceId[]): Promise<{
  inserted: number;
  warnings: string[];
}> {
  const settings = await getSettings();
  const targetSources: SourceId[] =
    requestedSources ||
    PATROL_SOURCE_IDS.filter((s) => settings.enabledSources[s]);

  let totalInserted = 0;
  const warnings: string[] = [];
  const deepFetchQueue: ExtractedCandidate[] = [];

  // 1. Fast RSS check for Zenn first (zero tab overhead!)
  if (targetSources.includes('zenn')) {
    try {
      updateJobProgress('Zenn トレンドフィードを取得中...');
      const rssRes = await fetch('https://zenn.dev/feed');
      if (rssRes.ok) {
        const xml = await rssRes.text();
        const rssCandidates = parseZennRssXml(xml);
        const res = await ingestCandidates(rssCandidates);
        totalInserted += res.inserted;
        deepFetchQueue.push(...rssCandidates.filter((c) => c.needsFullArticleFetch).slice(0, 2));
      }
    } catch {
      // Proceed to tab fallback
    }
  }

  // 2. Controlled single background tab patrol grouped clearly as "agentCast 巡回中"
  const patrolTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const patrolTabId = patrolTab.id;

  if (patrolTabId) {
    try {
      // Visually group the patrol tab in Chrome so it never confuses the user
      if (chrome.tabs.group && chrome.tabGroups?.update) {
        try {
          const groupId = await chrome.tabs.group({ tabIds: [patrolTabId] });
          await chrome.tabGroups.update(groupId, {
            title: PATROL_GROUP_TITLE,
            color: 'orange',
            collapsed: false,
          });
        } catch {
          // Tab group creation can fail in popup/incognito windows; safe to proceed
        }
      }

      for (const source of targetSources) {
        const meta = SOURCE_META[source];
        if (!meta?.startUrl) continue;

        updateJobProgress(`${meta.shortLabel} をログインセッションで読み取り中...`);

        await chrome.tabs.update(patrolTabId, { url: meta.startUrl });
        await waitForTabReady(patrolTabId, 16000);
        await sleep(
          source === 'x' || source === 'google_news' || source === 'youtube' ? 2400 : 1500
        );

        const scrollSteps = source === 'x' ? 2 : source === 'note' || source === 'youtube' ? 1 : 0;
        const extracted = await extractFromTab(patrolTabId, scrollSteps);

        if (extracted.blocked) {
          warnings.push(`${meta.shortLabel}: ${extracted.blockMessage || 'スキップしました'}`);
          continue;
        }

        const limited = extracted.candidates.slice(0, 12);
        const saved = await ingestCandidates(limited);
        totalInserted += saved.inserted;

        const needsDeep = limited.filter((c) => c.needsFullArticleFetch).slice(0, 2);
        deepFetchQueue.push(...needsDeep);

        broadcastEvent({ type: 'QUEUE_UPDATED' });
        await sleep(700 + Math.floor(Math.random() * 500));
      }

      // 2.5. Patrol user-added custom sites (DOM / Changelog / Readability / CSS selector)
      const activeCustomSites = (settings.customSites || []).filter(
        (s) => s.enabled && s.url.trim().startsWith('http')
      );

      for (const site of activeCustomSites) {
        if (site.extractionStrategy === 'rss') {
          try {
            updateJobProgress(`RSS取得中: ${site.name}...`);
            const rssRes = await fetch(site.url);
            if (rssRes.ok) {
              const xml = await rssRes.text();
              const rssCandidates = parseGenericRssOrAtomXml(xml, site.name, site.url);
              const saved = await ingestCandidates(rssCandidates);
              totalInserted += saved.inserted;
              broadcastEvent({ type: 'QUEUE_UPDATED' });
            } else {
              warnings.push(`${site.name}: RSS取得エラー (HTTP ${rssRes.status})`);
            }
          } catch (rssErr) {
            warnings.push(
              `${site.name}: RSS取得失敗 (${rssErr instanceof Error ? rssErr.message : String(rssErr)})`
            );
          }
          continue;
        }

        updateJobProgress(`カスタムサイト巡回中: ${site.name}...`);
        await chrome.tabs.update(patrolTabId, { url: site.url });
        await waitForTabReady(patrolTabId, 16000);
        await sleep(1600);

        const extracted = await extractFromTab(patrolTabId, site.scrollSteps ?? 0, {
          strategy: site.extractionStrategy,
          cssSelector: site.cssSelector,
          siteName: site.name,
        });

        if (extracted.blocked) {
          warnings.push(`${site.name}: ${extracted.blockMessage || 'スキップしました'}`);
          continue;
        }

        const saved = await ingestCandidates(extracted.candidates.slice(0, 12));
        totalInserted += saved.inserted;
        broadcastEvent({ type: 'QUEUE_UPDATED' });
        await sleep(600);
      }

      // 3. Expand top 4 headline/pickup items (e.g. Yahoo! Pickup -> Full Article, Note/Zenn body)
      for (const target of deepFetchQueue.slice(0, 4)) {
        updateJobProgress(`注目記事の本文を展開中: ${target.title.slice(0, 28)}…`);
        await chrome.tabs.update(patrolTabId, { url: target.url });
        await waitForTabReady(patrolTabId, 14000);
        await sleep(1100);

        const deepExtracted = await extractFromTab(patrolTabId, 0);
        if (!deepExtracted.blocked && deepExtracted.candidates.length > 0) {
          const first = deepExtracted.candidates[0];
          if (
            target.source === 'yahoo_news' &&
            first.needsFullArticleFetch &&
            first.outboundUrls[0]
          ) {
            await chrome.tabs.update(patrolTabId, { url: first.outboundUrls[0] });
            await waitForTabReady(patrolTabId, 12000);
            await sleep(900);
            const fullYahoo = await extractFromTab(patrolTabId, 0);
            if (!fullYahoo.blocked && fullYahoo.candidates.length > 0) {
              await ingestCandidates(fullYahoo.candidates);
              continue;
            }
          }
          await ingestCandidates(deepExtracted.candidates);
        }
      }
    } finally {
      await chrome.tabs.remove(patrolTabId).catch(() => {});
    }
  }

  broadcastEvent({ type: 'QUEUE_UPDATED' });
  return { inserted: totalInserted, warnings };
}

async function patrolSingleCustomSite(site: CustomSiteConfig): Promise<{
  inserted: number;
  items: FeedItem[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  if (site.extractionStrategy === 'rss') {
    updateJobProgress(`RSS取得中: ${site.name}...`);
    const rssRes = await fetch(site.url);
    if (!rssRes.ok) {
      throw new Error(`${site.name} のRSS取得に失敗しました (HTTP ${rssRes.status})`);
    }
    const xml = await rssRes.text();
    const candidates = parseGenericRssOrAtomXml(xml, site.name, site.url);
    const saved = await ingestCandidates(candidates);
    broadcastEvent({ type: 'QUEUE_UPDATED' });
    return { inserted: saved.inserted, items: saved.items, warnings };
  }

  const patrolTab = await chrome.tabs.create({ url: site.url, active: false });
  const tabId = patrolTab.id;
  if (!tabId) {
    throw new Error('巡回タブを作成できませんでした。');
  }

  try {
    if (chrome.tabs.group && chrome.tabGroups?.update) {
      try {
        const groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await chrome.tabGroups.update(groupId, {
          title: PATROL_GROUP_TITLE,
          color: 'orange',
          collapsed: false,
        });
      } catch {
        // Ignore
      }
    }

    updateJobProgress(`カスタムサイト取得中: ${site.name}...`);
    await waitForTabReady(tabId, 16000);
    await sleep(1500);

    const extracted = await extractFromTab(tabId, site.scrollSteps ?? 0, {
      strategy: site.extractionStrategy,
      cssSelector: site.cssSelector,
      siteName: site.name,
    });

    if (extracted.blocked) {
      warnings.push(`${site.name}: ${extracted.blockMessage || 'ブロック検知'}`);
      return { inserted: 0, items: [], warnings };
    }

    const saved = await ingestCandidates(extracted.candidates.slice(0, 14));
    broadcastEvent({ type: 'QUEUE_UPDATED' });
    return { inserted: saved.inserted, items: saved.items, warnings };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function getProviderLabels(settings: ExtensionSettings): {
  providerLabel: string;
  ttsEngineLabel: string;
} {
  const aiMap: Record<ExtensionSettings['aiMode'], string> = {
    gemini_api: `Gemini API (${settings.geminiModel})`,
    openai_api: `OpenAI API (${settings.openaiModel})`,
    web_chatgpt: 'ChatGPT Plus/Pro (Webセッション)',
    web_gemini: 'Gemini Pro/Ultra (Webセッション)',
  };

  const ttsMap: Record<ExtensionSettings['ttsMode'], string> = {
    gemini_tts: `Gemini Multi-Speaker TTS (${settings.hostAVoice} & ${settings.hostBVoice})`,
    openai_tts: 'OpenAI Multi-Voice TTS',
    macos_speech: 'macOS Web Speech (ローカル日本語音声)',
  };

  return {
    providerLabel: aiMap[settings.aiMode],
    ttsEngineLabel: ttsMap[settings.ttsMode],
  };
}

async function loadRecentTopicDigests(limit = 8, maxDays = 7): Promise<RecentTopicDigest[]> {
  const cutoff = Date.now() - maxDays * 86_400_000;
  const recentEps = await db.episodes.orderBy('createdAt').reverse().limit(20).toArray();
  return recentEps
    .filter(
      (ep) =>
        ep.status === 'ready' &&
        !ep.id.startsWith('demo-') &&
        (Date.parse(ep.createdAt) || 0) >= cutoff &&
        ep.chapters.length > 0
    )
    .slice(0, limit)
    .map((ep) => ({
      episodeTitle: ep.title,
      createdAt: ep.createdAt,
      chapters: ep.chapters.map((c) => ({ title: c.title, summary: c.summary })),
      coveredUrls: ep.chapters.flatMap((c) => c.sourceItems.map((s) => s.url)),
    }));
}

async function generateEpisodeFromItems(
  explicitItems?: FeedItem[]
): Promise<PodcastEpisode> {
  const settings = await getSettings();
  const isExplicit = Boolean(explicitItems && explicitItems.length > 0);
  const rawQueueItems = isExplicit
    ? explicitItems!
    : await getUnreadQueue((settings.maxItemsPerPatrol || 24) + 16);

  if (rawQueueItems.length === 0) {
    throw new Error(
      '未読キューが空です。「巡回して番組作成」または「＋ 今のタブ」を実行してください。'
    );
  }

  const now = Date.now();
  const recentTopics = await loadRecentTopicDigests(8, 7);
  const filtered = filterFreshAndUniqueItems(rawQueueItems, recentTopics, {
    now,
    maxAgeHours: settings.radarWindowHours || 72,
    enforceFreshness: !isExplicit,
  });

  // Mark dropped stale/duplicate queue items so they don't clog future patrols
  if (filtered.droppedStaleIds.length > 0) {
    await markItemsConsumed(filtered.droppedStaleIds, 'skipped-stale');
  }
  if (filtered.droppedDupIds.length > 0) {
    await markItemsConsumed(filtered.droppedDupIds, 'skipped-duplicate');
  }
  if (filtered.droppedStaleIds.length > 0 || filtered.droppedDupIds.length > 0) {
    broadcastEvent({ type: 'QUEUE_UPDATED' });
  }

  const queueItems = filtered.kept.slice(0, settings.maxItemsPerPatrol || 24);
  if (queueItems.length === 0) {
    throw new Error(
      '過去番組と重複していない最新アイテムがありませんでした。新しく巡回してからお試しください。'
    );
  }

  const episodeId = `ep-${now}`;
  const nowIso = new Date(now).toISOString();
  const labels = getProviderLabels(settings);
  const promptOpts = { now, recentTopics };

  const placeholder: PodcastEpisode = {
    id: episodeId,
    title: '番組台本を構成中...',
    subtitle: `${queueItems.length}件の最新記事・SNSポストを整理しています`,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: 'generating_script',
    statusDetail: `${labels.providerLabel} で2人掛け合い台本を作成中...`,
    providerLabel: labels.providerLabel,
    ttsEngineLabel: labels.ttsEngineLabel,
    chapters: [],
    totalDurationSec: 0,
    sourceCount: queueItems.length,
  };

  await db.episodes.put(placeholder);
  updateJobProgress(`${labels.providerLabel} で番組台本を作成中...`);
  broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

  try {
    let generated: { title: string; subtitle: string; chapters: PodcastEpisode['chapters'] };

    if (settings.aiMode === 'gemini_api') {
      generated = await generateScriptWithGemini(queueItems, settings, promptOpts);
    } else if (settings.aiMode === 'openai_api') {
      generated = await generateScriptWithOpenAI(queueItems, settings, promptOpts);
    } else if (settings.aiMode === 'web_chatgpt') {
      generated = await generateScriptViaWebSession('chatgpt', queueItems, settings, promptOpts);
    } else {
      generated = await generateScriptViaWebSession('gemini', queueItems, settings, promptOpts);
    }

    let effectiveTts = settings.ttsMode;
    if (effectiveTts === 'gemini_tts' && !settings.geminiApiKey.trim()) {
      effectiveTts = 'macos_speech';
    } else if (effectiveTts === 'openai_tts' && !settings.openaiApiKey.trim()) {
      effectiveTts = 'macos_speech';
    }

    const episodeWithScript: PodcastEpisode = {
      ...placeholder,
      title: generated.title,
      subtitle: generated.subtitle,
      updatedAt: new Date().toISOString(),
      chapters: generated.chapters,
      totalDurationSec: generated.chapters.reduce((s, c) => s + c.durationSec, 0),
      status: effectiveTts === 'macos_speech' ? 'ready' : 'synthesizing_audio',
      statusDetail:
        effectiveTts === 'macos_speech'
          ? undefined
          : `チャプター 1/${generated.chapters.length} の音声を合成中...`,
      ttsEngineLabel:
        effectiveTts === 'macos_speech'
          ? 'macOS Web Speech (ローカル日本語音声)'
          : labels.ttsEngineLabel,
    };

    await db.episodes.put(episodeWithScript);
    broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

    if (effectiveTts !== 'macos_speech') {
      let autoPlayTriggered = false;

      for (let i = 0; i < episodeWithScript.chapters.length; i++) {
        const ch = episodeWithScript.chapters[i];
        const progressText = `チャプター ${i + 1}/${episodeWithScript.chapters.length}「${ch.title.slice(0, 20)}」を音声合成中...`;
        episodeWithScript.statusDetail = progressText;
        episodeWithScript.updatedAt = new Date().toISOString();
        updateJobProgress(progressText);
        await db.episodes.put({ ...episodeWithScript });
        broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

        try {
          const audioRes =
            effectiveTts === 'gemini_tts'
              ? await synthesizeChapterWithGeminiTts(ch, settings)
              : await synthesizeChapterWithOpenAITts(ch, settings);

          await db.chapterAudio.put({
            chapterKey: makeChapterKey(episodeId, i),
            episodeId,
            chapterIndex: i,
            blob: audioRes.blob,
            mimeType: audioRes.mimeType,
            durationSec: audioRes.durationSec,
            createdAt: new Date().toISOString(),
          });

          episodeWithScript.chapters[i] = {
            ...ch,
            durationSec: audioRes.durationSec,
            hasAudioBlob: true,
          };
          episodeWithScript.totalDurationSec = episodeWithScript.chapters.reduce(
            (s, c) => s + c.durationSec,
            0
          );
          episodeWithScript.updatedAt = new Date().toISOString();
          await db.episodes.put({ ...episodeWithScript });
          broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

          if (i === 0 && !autoPlayTriggered && !latestPlaybackState.isPlaying) {
            autoPlayTriggered = true;
            await playEpisodeInOffscreen(episodeWithScript, 0, settings.playbackRate);
          }
        } catch (ttsErr) {
          console.warn(`[agentCast] Chapter ${i} TTS fallback to Web Speech:`, ttsErr);
        }
      }

      episodeWithScript.status = 'ready';
      episodeWithScript.statusDetail = undefined;
      episodeWithScript.updatedAt = new Date().toISOString();
      await db.episodes.put({ ...episodeWithScript });
    } else if (!latestPlaybackState.isPlaying) {
      await playEpisodeInOffscreen(episodeWithScript, 0, settings.playbackRate);
    }

    await markItemsConsumed(
      queueItems.map((i) => i.id),
      episodeId
    );
    broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });
    broadcastEvent({ type: 'QUEUE_UPDATED' });
    return episodeWithScript;
  } catch (err) {
    // Delete empty placeholder so "番組台本を構成中..." zombies never pile up in the episode picker
    await deleteEpisodeById(episodeId);
    throw err;
  }
}

async function patrolAndGenerateEpisode(sources?: SourceId[]): Promise<{
  warnings: string[];
}> {
  const patrolRes = await patrolSources(sources);
  const warnings = [...patrolRes.warnings];
  const settings = await getSettings();
  if (settings.radarIncludeInPatrol && !sources) {
    try {
      const radar = await runRadarCheck(radarDeps);
      warnings.push(...radar.warnings);
      await ingestRadarCandidates();
    } catch (err) {
      warnings.push(`動向レーダー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await generateEpisodeFromItems();
  return { warnings };
}

// ---------------------------------------------------------------------------
// Follow radar + video digests (v0.4.0)
// ---------------------------------------------------------------------------

async function openGroupedPatrolTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error('巡回タブを作成できませんでした。');
  if (chrome.tabs.group && chrome.tabGroups?.update) {
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, {
        title: PATROL_GROUP_TITLE,
        color: 'orange',
        collapsed: false,
      });
    } catch {
      // Ignore (popup / incognito windows)
    }
  }
  return tab.id;
}

const radarDeps: RadarDeps = {
  updateJobProgress,
  broadcastEvent,
  openPatrolTab: openGroupedPatrolTab,
  waitForTabReady,
  extractFromTab: (tabId, scrollSteps) => extractFromTab(tabId, scrollSteps ?? 0),
};

async function ingestRadarCandidates(): Promise<FeedItem[]> {
  const targets = await db.watchTargets.toArray();
  const digests = new Map((await db.videoDigests.toArray()).map((d) => [d.videoId, d]));
  const candidates = buildRadarCandidates(targets, digests);
  if (candidates.length === 0) return [];
  const saved = await ingestCandidates(candidates);
  broadcastEvent({ type: 'QUEUE_UPDATED' });
  return saved.items;
}

function buildDigestLlmRunner(settings: ExtensionSettings): DigestLlmRunner | null {
  const hasGemini = Boolean(settings.geminiApiKey.trim());
  const hasOpenAI = Boolean(settings.openaiApiKey.trim());
  const gemini: DigestLlmRunner = (prompt, opts) =>
    generateTextWithGemini(
      prompt,
      settings,
      opts.useVideoInput && opts.videoUrl ? [{ fileData: { fileUri: opts.videoUrl } }] : []
    );
  const openai: DigestLlmRunner = (prompt) => generateTextWithOpenAI(prompt, settings);

  if (settings.aiMode === 'gemini_api' && hasGemini) return gemini;
  if (settings.aiMode === 'openai_api' && hasOpenAI) return openai;
  if (settings.aiMode === 'web_chatgpt' || settings.aiMode === 'web_gemini') {
    if (hasGemini) return gemini; // API is faster than driving a web tab per video
    if (__AGENTCAST_TARGET__ === 'main') {
      const provider = settings.aiMode === 'web_chatgpt' ? 'chatgpt' : 'gemini';
      return (prompt) => runPromptViaWebSession(provider, prompt);
    }
  }
  if (hasGemini) return gemini;
  if (hasOpenAI) return openai;
  return null;
}

function startVideoDigest(videoUrl: string, force = false): string {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) throw new Error('YouTube動画のURLではありません。');
  if (digestInProgress.has(videoId)) return videoId;

  digestInProgress.set(videoId, '準備中...');
  broadcastEvent({ type: 'VIDEO_DIGEST_PROGRESS', videoId, message: '準備中...' });

  void withServiceWorkerKeepAlive(async () => {
    try {
      if (!force) {
        const cached = await db.videoDigests.get(videoId);
        if (cached) {
          broadcastEvent({ type: 'VIDEO_DIGEST_UPDATED', videoId });
          return;
        }
      }
      const settings = await getSettings();
      const digest = await summarizeYouTubeVideo(
        videoUrl,
        settings,
        buildDigestLlmRunner(settings),
        (message) => {
          digestInProgress.set(videoId, message);
          broadcastEvent({ type: 'VIDEO_DIGEST_PROGRESS', videoId, message });
        }
      );
      await db.videoDigests.put(digest);
      broadcastEvent({ type: 'VIDEO_DIGEST_UPDATED', videoId });
    } catch (err) {
      broadcastEvent({
        type: 'VIDEO_DIGEST_UPDATED',
        videoId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      digestInProgress.delete(videoId);
    }
  });

  return videoId;
}

async function playEpisodeInOffscreen(
  episode: PodcastEpisode,
  chapterIndex = 0,
  rate?: number
): Promise<void> {
  await ensureOffscreenDocument();
  const settings = await getSettings();
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_PLAY_EPISODE',
    episode,
    chapterIndex,
    rate: rate ?? settings.playbackRate ?? 1.0,
  } satisfies RuntimeRequest);
}

chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
  switch (message?.type) {
    case 'PASSIVE_CANDIDATES':
      void (async () => {
        const settings = await getSettings();
        if (!settings.passiveCaptureEnabled) {
          sendResponse({ ok: true, skipped: true });
          return;
        }
        const res = await ingestCandidates(message.candidates);
        if (res.inserted > 0) {
          broadcastEvent({ type: 'QUEUE_UPDATED' });
        }
        sendResponse({ ok: true, inserted: res.inserted });
      })();
      return true;

    case 'CAPTURE_ACTIVE_TAB':
      void captureActiveTab()
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'CAPTURE_AND_GENERATE_ACTIVE_TAB':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の番組生成が実行中です。完了までお待ちください。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('現在のタブを読み取り中...', async () => {
        const captured = await captureActiveTab();
        if (captured.warning) {
          throw new Error(captured.warning);
        }
        if (captured.items.length === 0) {
          throw new Error('このページから読み取れる記事・リリース情報が見つかりませんでした。');
        }
        await generateEpisodeFromItems(captured.items);
      });
      return false;

    case 'LIST_TAB_GROUPS':
      void listUserTabGroups()
        .then((groups) => sendResponse({ ok: true, groups }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'PATROL_TAB_GROUP':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('選択したタブグループを巡回中...', async () => {
        const res = await patrolTabGroup(message.groupId);
        if (message.generateAfter !== false && res.items.length > 0) {
          await generateEpisodeFromItems(res.items);
        }
        return { warnings: res.warnings };
      });
      return false;

    case 'PATROL_SOURCES':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('フォロー中サイトを巡回中...', async () => {
        const res = await patrolSources(message.sources);
        return { warnings: res.warnings };
      });
      return false;

    case 'GENERATE_EPISODE_FROM_QUEUE':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('未読キューから番組台本を構成中...', async () => {
        await generateEpisodeFromItems();
      });
      return false;

    case 'PATROL_AND_GENERATE':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('フォロー中サイトを巡回して番組を編成中...', async () => {
        return patrolAndGenerateEpisode(message.sources);
      });
      return false;

    case 'GET_JOB_STATUS':
      sendResponse({
        ok: true,
        isJobRunning,
        message: currentJobMessage,
        lastError: lastJobError,
      });
      return false;

    case 'DELETE_EPISODE':
      void deleteEpisodeById(message.episodeId).then(() => sendResponse({ ok: true }));
      return true;

    case 'CLEANUP_STALE_EPISODES':
      void cleanupStaleEpisodes(true).then((removed) => sendResponse({ ok: true, removed }));
      return true;

    case 'CREATE_DEMO_EPISODE':
      void (async () => {
        const settings = await getSettings();
        const demo = createDemoEpisode(settings);
        await db.episodes.put(demo);
        broadcastEvent({ type: 'EPISODES_UPDATED', episodeId: demo.id });
        await playEpisodeInOffscreen(demo, 0, settings.playbackRate);
        sendResponse({ ok: true, episode: demo });
      })();
      return true;

    case 'PLAY_EPISODE':
      void (async () => {
        const ep = await db.episodes.get(message.episodeId);
        if (!ep) {
          sendResponse({ ok: false, error: 'エピソードが見つかりません' });
          return;
        }
        await playEpisodeInOffscreen(ep, message.chapterIndex ?? 0);
        sendResponse({ ok: true });
      })();
      return true;

    case 'TOGGLE_PLAY_PAUSE':
      void (async () => {
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_TOGGLE_PLAY_PAUSE',
        } satisfies RuntimeRequest);
        sendResponse(res);
      })();
      return true;

    case 'SKIP_CHAPTER':
      void (async () => {
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SKIP_CHAPTER',
          delta: message.delta,
        } satisfies RuntimeRequest);
        sendResponse(res);
      })();
      return true;

    case 'SEEK_RELATIVE':
      void (async () => {
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SEEK_RELATIVE',
          deltaSec: message.deltaSec,
        } satisfies RuntimeRequest);
        sendResponse(res);
      })();
      return true;

    case 'SET_PLAYBACK_RATE':
      void (async () => {
        await saveSettings({ playbackRate: message.rate });
        await ensureOffscreenDocument();
        const res = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SET_RATE',
          rate: message.rate,
        } satisfies RuntimeRequest);
        sendResponse(res);
      })();
      return true;

    case 'GET_PLAYBACK_STATE':
      sendResponse({ ok: true, state: latestPlaybackState });
      return false;

    case 'OFFSCREEN_STATE_PUSH':
      latestPlaybackState = message.state;
      broadcastEvent({ type: 'PLAYBACK_STATE_UPDATED', state: latestPlaybackState });
      sendResponse({ ok: true });
      return false;

    case 'GET_DEV_BUILD_STATUS':
      sendResponse({ ok: true, status: getDevBuildStatus() });
      return false;

    case 'TRIGGER_DEV_RELOAD_NOW':
      sendResponse({ ok: true });
      setTimeout(() => chrome.runtime.reload(), 120);
      return false;

    case 'UPDATE_SETTINGS':
      void (async () => {
        const updated = await saveSettings(message.settings);
        await syncDailyAlarm();
        sendResponse({ ok: true, settings: updated });
      })();
      return true;

    case 'PATROL_CUSTOM_SITE':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('カスタムサイトを読み取り中...', async () => {
        const settings = await getSettings();
        const site = (settings.customSites || []).find((s) => s.id === message.siteId);
        if (!site) throw new Error('指定されたカスタムサイトが見つかりません。');
        const res = await patrolSingleCustomSite(site);
        if (message.generateAfter && res.items.length > 0) {
          await generateEpisodeFromItems(res.items);
        }
        return { warnings: res.warnings };
      });
      return false;

    case 'START_GEMINI_KEY_SETUP':
      void startGeminiKeySetup()
        .then((tabId) => sendResponse({ ok: true, tabId }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'GEMINI_KEY_CAPTURED':
      void (async () => {
        const key = (message.apiKey || '').trim();
        const verify = await verifyGeminiApiKey(key);
        if (!verify.valid) {
          sendResponse({ ok: false, error: verify.message });
          return;
        }
        await saveSettings({
          geminiApiKey: key,
          aiMode: 'gemini_api',
          ttsMode: 'gemini_tts',
        });
        broadcastEvent({
          type: 'GEMINI_KEY_SETUP_DONE',
          valid: true,
          message: verify.message,
        });
        sendResponse({ ok: true, message: verify.message });
      })();
      return true;

    case 'VERIFY_GEMINI_KEY':
      void (async () => {
        const key = (message.apiKey ?? (await getSettings()).geminiApiKey).trim();
        const result = await verifyGeminiApiKey(key);
        sendResponse({ ok: result.valid, message: result.message });
      })();
      return true;

    case 'START_PUBLISH_JOB':
      void startPublishJob(message.job)
        .then((tabId) => sendResponse({ ok: true, tabId }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'GET_PENDING_PUBLISH_JOB':
      sendResponse({ ok: true, job: pendingPublishJob });
      return false;

    case 'CLEAR_PENDING_PUBLISH_JOB':
      pendingPublishJob = null;
      sendResponse({ ok: true });
      return false;

    case 'RADAR_CHECK':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('登録チャンネル・フォロー動向をチェック中...', async () => {
        const res = await runRadarCheck(radarDeps, { platforms: message.platforms });
        broadcastEvent({ type: 'RADAR_CHECK_DONE', ...res });
        return { warnings: res.warnings };
      });
      return false;

    case 'RADAR_IMPORT_YOUTUBE_SUBS':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('YouTube 登録チャンネルを取り込み中...', async () => {
        const res = await importYouTubeSubscriptions(radarDeps);
        broadcastEvent({
          type: 'RADAR_IMPORT_DONE',
          message: `YouTube 登録チャンネル ${res.total} 件中 ${res.added} 件を追加しました。`,
        });
      });
      return false;

    case 'RADAR_IMPORT_X_FOLLOWING':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('X のフォロー一覧を取り込み中...', async () => {
        const res = await importXFollowing(radarDeps, message.maxCount ?? 300);
        broadcastEvent({
          type: 'RADAR_IMPORT_DONE',
          message: `@${res.handle} のフォロー ${res.total} 件中 ${res.added} 件を追加しました（X は初期状態でOFF。監視したい人だけONにしてください）。`,
        });
      });
      return false;

    case 'RADAR_ADD_TARGET':
      void addWatchTarget(message.platform, message.input, message.name)
        .then((target) => {
          broadcastEvent({ type: 'RADAR_UPDATED' });
          sendResponse({ ok: true, target });
        })
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'RADAR_GENERATE_EPISODE':
      if (isJobRunning) {
        sendResponse({ ok: false, error: '現在別の巡回・番組生成が実行中です。' });
        return false;
      }
      sendResponse({ ok: true, started: true });
      void runBackgroundJob('フォロー動向から番組を編成中...', async () => {
        const warnings: string[] = [];
        if (message.checkFirst) {
          const res = await runRadarCheck(radarDeps);
          warnings.push(...res.warnings);
        }
        const items = await ingestRadarCandidates();
        if (items.length === 0) {
          throw new Error('動向データがありません。先に「動向をチェック」を実行してください。');
        }
        await generateEpisodeFromItems(items);
        return { warnings };
      });
      return false;

    case 'SUMMARIZE_YOUTUBE_VIDEO':
      try {
        const videoId = startVideoDigest(message.videoUrl, message.force);
        sendResponse({ ok: true, videoId });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;

    case 'SUMMARIZE_ACTIVE_YOUTUBE_TAB':
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url || !extractYouTubeVideoId(tab.url)) {
          sendResponse({ ok: false, error: '現在のタブで YouTube 動画を開いてから実行してください。' });
          return;
        }
        const videoId = startVideoDigest(tab.url, true);
        sendResponse({ ok: true, videoId, url: tab.url });
      })();
      return true;

    case 'GET_DIGEST_PROGRESS':
      sendResponse({ ok: true, progress: Object.fromEntries(digestInProgress) });
      return false;

    default:
      return false;
  }
});

let pendingPublishJob: PendingPublishJob | null = null;

async function startPublishJob(job: PendingPublishJob): Promise<number | undefined> {
  pendingPublishJob = job;

  const tab = await chrome.tabs.create({
    url: job.targetUrl,
    active: true,
  });
  const tabId = tab.id;
  if (!tabId) return undefined;

  const expectedHost =
    job.platform === 'youtube' ? 'studio.youtube.com' : 'x.com';
  const helperFn =
    job.platform === 'youtube' ? injectYouTubePublishHelper : injectXPublishHelper;

  const tryInject = async () => {
    try {
      const current = await chrome.tabs.get(tabId);
      if (!current.url) return;
      const host = new URL(current.url).hostname;
      if (!host.includes(expectedHost) && !(job.platform === 'x' && host.includes('twitter.com'))) {
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: helperFn,
      });
    } catch {
      // Ignore transient redirect errors
    }
  };

  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') {
      setTimeout(() => void tryInject(), 1100);
    }
  };

  const cleanup = () => {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  };

  const onRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) cleanup();
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  setTimeout(cleanup, 10 * 60 * 1000);

  void (async () => {
    await waitForTabReady(tabId, 16000);
    await sleep(1200);
    await tryInject();
  })();

  return tabId;
}

async function startGeminiKeySetup(): Promise<number | undefined> {
  const tab = await chrome.tabs.create({
    url: 'https://aistudio.google.com/apikey',
    active: true,
  });
  const tabId = tab.id;
  if (!tabId) return undefined;

  const tryInject = async () => {
    try {
      const current = await chrome.tabs.get(tabId);
      if (!current.url || !current.url.startsWith('https://aistudio.google.com/')) {
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectAiStudioKeyHelper,
      });
    } catch {
      // Ignore transient navigation or permission errors while Google login redirects
    }
  };

  // Re-inject automatically when AI Studio finishes loading or redirects back after sign-in
  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') {
      setTimeout(() => void tryInject(), 900);
    }
  };

  const cleanup = () => {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  };

  const onRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) cleanup();
  };

  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(onRemoved);
  setTimeout(cleanup, 5 * 60 * 1000);

  // Inject asynchronously so sendResponse({ ok: true, tabId }) returns IMMEDIATELY without timing out!
  void (async () => {
    await waitForTabReady(tabId, 16000);
    await sleep(1000);
    await tryInject();
  })();

  return tabId;
}
