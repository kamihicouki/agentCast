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
  type PlaybackState,
  type PodcastEpisode,
  type SourceId,
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

const ALARM_MORNING_CAST = 'agentcast_scheduled_generation';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let latestPlaybackState: PlaybackState = { ...INITIAL_PLAYBACK_STATE };
let isGeneratingEpisode = false;

// Open Side Panel automatically when clicking the toolbar icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[agentCast] sidePanel.setPanelBehavior warning:', err));

// Start Cloud -> Local Chrome instant auto-reloader (main personal branch only)
startDevAutoReloader(() => latestPlaybackState.isPlaying);

chrome.runtime.onInstalled.addListener(async () => {
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
    void patrolAndGenerateEpisode();
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
      justification: 'Side Panelの開閉やタブ移動に依存せずポッドキャスト音声とMediaSessionを維持するため',
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  await creatingOffscreen;
}

function broadcastEvent(payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage(payload).catch(() => {});
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
  warning?: string;
}> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('現在のタブは読み取り対象外のページ（Chrome内部ページ等）です。');
  }

  const res = await extractFromTab(tab.id, 1);
  if (res.blocked) {
    return { inserted: 0, updated: 0, warning: res.blockMessage };
  }

  const stored = await ingestCandidates(res.candidates);
  broadcastEvent({ type: 'QUEUE_UPDATED' });
  return { inserted: stored.inserted, updated: stored.updated };
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
      broadcastEvent({
        type: 'PATROL_PROGRESS',
        message: 'Zenn トレンドフィードを取得中...',
      });
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

  // 2. Controlled single background tab patrol using user's signed-in browser session
  const patrolTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const patrolTabId = patrolTab.id;

  if (patrolTabId) {
    try {
      for (const source of targetSources) {
        const meta = SOURCE_META[source];
        if (!meta?.startUrl) continue;

        broadcastEvent({
          type: 'PATROL_PROGRESS',
          message: `${meta.shortLabel} をログインセッションで読み取り中...`,
        });

        await chrome.tabs.update(patrolTabId, { url: meta.startUrl });
        await waitForTabReady(patrolTabId, 16000);
        // Human-paced settle delay for SPA hydration (React/Next.js on X, Note, Google News)
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
        broadcastEvent({
          type: 'PATROL_PROGRESS',
          message: `注目記事の本文を展開中: ${target.title.slice(0, 28)}…`,
        });
        await chrome.tabs.update(patrolTabId, { url: target.url });
        await waitForTabReady(patrolTabId, 14000);
        await sleep(1100);

        const deepExtracted = await extractFromTab(patrolTabId, 0);
        if (!deepExtracted.blocked && deepExtracted.candidates.length > 0) {
          // If Yahoo Pickup returned the full article link, follow one hop
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
  broadcastEvent({ type: 'PATROL_PROGRESS', message: '' });
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

async function generateEpisodeFromQueue(): Promise<PodcastEpisode> {
  if (isGeneratingEpisode) {
    throw new Error('現在エピソードを生成中です。完了まで少々お待ちください。');
  }

  const settings = await getSettings();
  const queueItems = await getUnreadQueue(settings.maxItemsPerPatrol || 24);
  if (queueItems.length === 0) {
    throw new Error(
      '未読キューが空です。「5サイト巡回して番組作成」または「現在のタブを追加」を実行してください。'
    );
  }

  isGeneratingEpisode = true;
  const episodeId = `ep-${Date.now()}`;
  const labels = getProviderLabels(settings);

  const placeholder: PodcastEpisode = {
    id: episodeId,
    title: '番組台本を構成中...',
    subtitle: `${queueItems.length}件の新着記事・SNSポストを整理しています`,
    createdAt: new Date().toISOString(),
    status: 'generating_script',
    statusDetail: `${labels.providerLabel} で2人掛け合い台本を作成中...`,
    providerLabel: labels.providerLabel,
    ttsEngineLabel: labels.ttsEngineLabel,
    chapters: [],
    totalDurationSec: 0,
    sourceCount: queueItems.length,
  };

  await db.episodes.put(placeholder);
  broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

  try {
    let generated: { title: string; subtitle: string; chapters: PodcastEpisode['chapters'] };

    // Auto-fallback to Web Session or helpful error if API mode selected without key
    if (settings.aiMode === 'gemini_api') {
      generated = await generateScriptWithGemini(queueItems, settings);
    } else if (settings.aiMode === 'openai_api') {
      generated = await generateScriptWithOpenAI(queueItems, settings);
    } else if (settings.aiMode === 'web_chatgpt') {
      generated = await generateScriptViaWebSession('chatgpt', queueItems, settings);
    } else {
      generated = await generateScriptViaWebSession('gemini', queueItems, settings);
    }

    // Decide effective TTS mode (auto-fallback to macos_speech if cloud TTS key is missing)
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

    // Synthesize cloud multi-speaker audio chapter-by-chapter, auto-starting playback once Chapter 0 is ready!
    if (effectiveTts !== 'macos_speech') {
      let autoPlayTriggered = false;

      for (let i = 0; i < episodeWithScript.chapters.length; i++) {
        const ch = episodeWithScript.chapters[i];
        episodeWithScript.statusDetail = `チャプター ${i + 1}/${episodeWithScript.chapters.length}「${ch.title.slice(0, 20)}」を音声合成中...`;
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
          await db.episodes.put({ ...episodeWithScript });
          broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });

          // Start streaming Chapter 0 immediately while remaining chapters synthesize in background!
          if (i === 0 && !autoPlayTriggered && !latestPlaybackState.isPlaying) {
            autoPlayTriggered = true;
            await playEpisodeInOffscreen(episodeWithScript, 0, settings.playbackRate);
          }
        } catch (ttsErr) {
          console.warn(`[agentCast] Chapter ${i} TTS fallback to Web Speech:`, ttsErr);
          // Leave hasAudioBlob=false so Offscreen seamlessly speaks this chapter via macOS Web Speech
        }
      }

      episodeWithScript.status = 'ready';
      episodeWithScript.statusDetail = undefined;
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
    const message = err instanceof Error ? err.message : String(err);
    await db.episodes.update(episodeId, {
      status: 'error',
      errorMessage: message,
      statusDetail: undefined,
    });
    broadcastEvent({ type: 'EPISODES_UPDATED', episodeId });
    throw err;
  } finally {
    isGeneratingEpisode = false;
  }
}

async function patrolAndGenerateEpisode(sources?: SourceId[]): Promise<{
  episode: PodcastEpisode;
  warnings: string[];
}> {
  const patrolRes = await patrolSources(sources);
  const episode = await generateEpisodeFromQueue();
  return { episode, warnings: patrolRes.warnings };
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

    case 'PATROL_SOURCES':
      void patrolSources(message.sources)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'GENERATE_EPISODE_FROM_QUEUE':
      void generateEpisodeFromQueue()
        .then((ep) => sendResponse({ ok: true, episode: ep }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
      return true;

    case 'PATROL_AND_GENERATE':
      void patrolAndGenerateEpisode(message.sources)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        );
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

    default:
      return false;
  }
});
