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
  SOURCE_META,
  type ExtractedCandidate,
  type ExtensionSettings,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type SourceId,
  type TabGroupSummary,
} from '../../shared/types';
import type { ExtractionResultPayload, RuntimeRequest } from '../../shared/messages';
import { parseZennRssXml } from '../../extractors/zenn';
import { createDemoEpisode } from '../../providers/prompt-builder';
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

const ALARM_MORNING_CAST = 'agentcast_scheduled_generation';
const PATROL_GROUP_TITLE = 'agentCast 巡回中';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let latestPlaybackState: PlaybackState = { ...INITIAL_PLAYBACK_STATE };
let isJobRunning = false;
let currentJobMessage = '';
let lastJobError = '';

// Open Side Panel automatically when clicking the toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[agentCast] sidePanel.setPanelBehavior warning:', err));

// Guard Dev Auto-Reloader during BOTH audio playback AND active generation jobs!
startDevAutoReloader(() => latestPlaybackState.isPlaying || isJobRunning);

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

async function extractFromTab(
  tabId: number,
  scrollSteps = 0
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
    (['x', 'note', 'zenn', 'yahoo_news', 'google_news'] as SourceId[]).filter(
      (s) => settings.enabledSources[s]
    );

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
        await sleep(source === 'x' || source === 'google_news' ? 2400 : 1500);

        const scrollSteps = source === 'x' ? 2 : source === 'note' ? 1 : 0;
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

async function generateEpisodeFromItems(
  explicitItems?: FeedItem[]
): Promise<PodcastEpisode> {
  const settings = await getSettings();
  const queueItems =
    explicitItems && explicitItems.length > 0
      ? explicitItems
      : await getUnreadQueue(settings.maxItemsPerPatrol || 24);

  if (queueItems.length === 0) {
    throw new Error(
      '未読キューが空です。「巡回して番組作成」または「＋ 今のタブ」を実行してください。'
    );
  }

  const episodeId = `ep-${Date.now()}`;
  const nowIso = new Date().toISOString();
  const labels = getProviderLabels(settings);

  const placeholder: PodcastEpisode = {
    id: episodeId,
    title: '番組台本を構成中...',
    subtitle: `${queueItems.length}件の新着記事・SNSポストを整理しています`,
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
      generated = await generateScriptWithGemini(queueItems, settings);
    } else if (settings.aiMode === 'openai_api') {
      generated = await generateScriptWithOpenAI(queueItems, settings);
    } else if (settings.aiMode === 'web_chatgpt') {
      generated = await generateScriptViaWebSession('chatgpt', queueItems, settings);
    } else {
      generated = await generateScriptViaWebSession('gemini', queueItems, settings);
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
  await generateEpisodeFromItems();
  return { warnings: patrolRes.warnings };
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

    default:
      return false;
  }
});

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

  // Re-inject automatically if user completes Google sign-in and redirects back to AI Studio
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

  await waitForTabReady(tabId, 16000);
  await sleep(1000);
  await tryInject();
  return tabId;
}
