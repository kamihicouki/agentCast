import { db, makeChapterKey, savePublishMedia } from '../../storage/db';
import type { RuntimeRequest } from '../../shared/messages';
import { renderEpisodeToMp4 } from '../../shared/publish-utils';
import {
  INITIAL_PLAYBACK_STATE,
  SOURCE_META,
  type EpisodeChapter,
  type PlaybackState,
  type PodcastEpisode,
} from '../../shared/types';

const audioEl = document.getElementById('agentcast-audio') as HTMLAudioElement;

let activeEpisode: PodcastEpisode | null = null;
let currentObjectUrl: string | null = null;
let speechSessionToken = 0;
let speechTimer: number | null = null;

const state: PlaybackState = { ...INITIAL_PLAYBACK_STATE };

function pushState(): void {
  chrome.runtime
    .sendMessage({
      type: 'OFFSCREEN_STATE_PUSH',
      state: { ...state },
    } satisfies RuntimeRequest)
    .catch(() => {});
}

function revokeCurrentUrl(): void {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function stopWebSpeech(): void {
  speechSessionToken++;
  if (speechTimer !== null) {
    window.clearInterval(speechTimer);
    speechTimer = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function updateMediaSessionMetadata(chapter: EpisodeChapter | undefined): void {
  if (!('mediaSession' in navigator) || !activeEpisode || !chapter) return;

  const primarySource = chapter.sourceItems[0];
  const sourceBadge = primarySource ? SOURCE_META[primarySource.source]?.shortLabel : 'agentCast';

  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapter.title,
    artist: `${sourceBadge} · ${activeEpisode.title}`,
    album: 'agentCast Personal Podcast',
    artwork: [
      { src: chrome.runtime.getURL('icons/icon-128.png'), sizes: '128x128', type: 'image/png' },
    ],
  });

  navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
}

function computeTurnIndexFromProgress(chapter: EpisodeChapter, progressRatio: number): number {
  if (chapter.turns.length <= 1) return 0;
  const weights = chapter.turns.map((t) => Math.max(1, t.text.length));
  const totalChars = weights.reduce((a, b) => a + b, 0);
  const target = Math.max(0, Math.min(1, progressRatio)) * totalChars;

  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (target <= acc) return i;
  }
  return chapter.turns.length - 1;
}

function pickJapaneseVoices(): { hostA?: SpeechSynthesisVoice; hostB?: SpeechSynthesisVoice } {
  if (!('speechSynthesis' in window)) return {};
  const jaVoices = window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith('ja'));

  if (jaVoices.length === 0) return {};

  // Prefer macOS Enhanced / Siri / Google Japanese voices when available
  const ranked = [...jaVoices].sort((a, b) => {
    const score = (v: SpeechSynthesisVoice) =>
      (v.name.includes('Enhanced') || v.name.includes('Premium') ? 4 : 0) +
      (v.name.includes('Otoya') || v.name.includes('Kyoko') || v.name.includes('Google') ? 2 : 0);
    return score(b) - score(a);
  });

  const otoya = ranked.find((v) => v.name.includes('Otoya') || v.name.includes('Hattori'));
  const kyoko = ranked.find((v) => v.name.includes('Kyoko') || v.name.includes('O-Ren'));

  return {
    hostA: otoya || ranked[0],
    hostB: kyoko || ranked[1] || ranked[0],
  };
}

async function playChapterViaWebSpeech(chapter: EpisodeChapter): Promise<void> {
  stopWebSpeech();
  audioEl.pause();
  revokeCurrentUrl();

  const myToken = ++speechSessionToken;
  state.mode = 'web_speech';
  state.chapterIndex = chapter.index;
  state.chapterTitle = chapter.title;
  state.turnIndex = 0;
  state.currentTimeSec = 0;
  state.durationSec = chapter.durationSec || 25;
  state.isPlaying = true;
  updateMediaSessionMetadata(chapter);
  pushState();

  if (!('speechSynthesis' in window)) {
    state.isPlaying = false;
    pushState();
    return;
  }

  // Ensure voice catalog is populated on macOS Chrome
  if (window.speechSynthesis.getVoices().length === 0) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      window.setTimeout(done, 400);
    });
  }

  const voices = pickJapaneseVoices();
  const startedAt = Date.now();
  speechTimer = window.setInterval(() => {
    if (!state.isPlaying || state.mode !== 'web_speech') return;
    state.currentTimeSec = Math.min(
      state.durationSec,
      Math.round(((Date.now() - startedAt) / 1000) * state.playbackRate)
    );
    pushState();
  }, 800);

  for (let i = 0; i < chapter.turns.length; i++) {
    if (myToken !== speechSessionToken) return;
    const turn = chapter.turns[i];
    state.turnIndex = i;
    pushState();

    await new Promise<void>((resolve) => {
      const utter = new SpeechSynthesisUtterance(turn.spokenText || turn.text);
      utter.lang = 'ja-JP';
      utter.rate = Math.min(2.0, Math.max(0.8, state.playbackRate * 1.04));
      if (turn.speaker === 'HostA') {
        if (voices.hostA) utter.voice = voices.hostA;
        utter.pitch = 0.95;
      } else {
        if (voices.hostB) utter.voice = voices.hostB;
        utter.pitch = 1.12;
      }
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }

  if (myToken !== speechSessionToken) return;
  if (speechTimer !== null) {
    window.clearInterval(speechTimer);
    speechTimer = null;
  }

  await advanceToNextChapterOrStop();
}

async function loadAndPlayChapter(chapterIndex: number): Promise<void> {
  if (!activeEpisode) return;

  // Reload latest episode record from DB in case subsequent chapters finished synthesizing while playing!
  const refreshed = await db.episodes.get(activeEpisode.id);
  if (refreshed) {
    activeEpisode = refreshed;
  }

  const chapter = activeEpisode.chapters[chapterIndex];
  if (!chapter) {
    state.isPlaying = false;
    pushState();
    return;
  }

  state.episodeId = activeEpisode.id;
  state.episodeTitle = activeEpisode.title;
  state.chapterIndex = chapterIndex;
  state.chapterTitle = chapter.title;
  state.turnIndex = 0;
  state.currentTimeSec = 0;

  const audioRecord = await db.chapterAudio.get(makeChapterKey(activeEpisode.id, chapterIndex));
  if (audioRecord?.blob) {
    stopWebSpeech();
    revokeCurrentUrl();
    currentObjectUrl = URL.createObjectURL(audioRecord.blob);
    audioEl.src = currentObjectUrl;
    audioEl.playbackRate = state.playbackRate;
    state.mode = 'audio_blob';
    state.durationSec = audioRecord.durationSec || chapter.durationSec || 30;
    state.isPlaying = true;
    updateMediaSessionMetadata(chapter);
    pushState();

    try {
      await audioEl.play();
    } catch (err) {
      console.warn('[agentCast Offscreen] Audio play failed, falling back to Web Speech:', err);
      await playChapterViaWebSpeech(chapter);
    }
  } else {
    await playChapterViaWebSpeech(chapter);
  }
}

async function advanceToNextChapterOrStop(): Promise<void> {
  if (!activeEpisode) return;
  const refreshed = await db.episodes.get(activeEpisode.id);
  if (refreshed) activeEpisode = refreshed;

  const nextIdx = state.chapterIndex + 1;
  if (nextIdx < activeEpisode.chapters.length) {
    await loadAndPlayChapter(nextIdx);
  } else {
    state.isPlaying = false;
    state.currentTimeSec = state.durationSec;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    pushState();
  }
}

audioEl.addEventListener('timeupdate', () => {
  if (!activeEpisode || state.mode !== 'audio_blob') return;
  const chapter = activeEpisode.chapters[state.chapterIndex];
  const dur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : state.durationSec;
  state.durationSec = dur;
  state.currentTimeSec = audioEl.currentTime;
  if (chapter && dur > 0) {
    state.turnIndex = computeTurnIndexFromProgress(chapter, audioEl.currentTime / dur);
  }
  pushState();
});

audioEl.addEventListener('ended', () => {
  void advanceToNextChapterOrStop();
});

async function togglePlayPause(): Promise<void> {
  if (!activeEpisode) return;

  if (state.mode === 'audio_blob') {
    if (audioEl.paused) {
      await audioEl.play();
      state.isPlaying = true;
    } else {
      audioEl.pause();
      state.isPlaying = false;
    }
  } else if (state.mode === 'web_speech' && 'speechSynthesis' in window) {
    if (state.isPlaying) {
      window.speechSynthesis.pause();
      state.isPlaying = false;
    } else if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      state.isPlaying = true;
    } else {
      await loadAndPlayChapter(state.chapterIndex);
      return;
    }
  } else {
    await loadAndPlayChapter(state.chapterIndex);
    return;
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }
  pushState();
}

async function skipChapter(delta: 1 | -1): Promise<void> {
  if (!activeEpisode) return;
  const refreshed = await db.episodes.get(activeEpisode.id);
  if (refreshed) activeEpisode = refreshed;

  const target = Math.max(
    0,
    Math.min(activeEpisode.chapters.length - 1, state.chapterIndex + delta)
  );
  await loadAndPlayChapter(target);
}

function seekRelative(deltaSec: number): void {
  if (state.mode !== 'audio_blob') return;
  const dur = Number.isFinite(audioEl.duration) ? audioEl.duration : state.durationSec;
  audioEl.currentTime = Math.max(0, Math.min(dur, audioEl.currentTime + deltaSec));
  state.currentTimeSec = audioEl.currentTime;
  pushState();
}

function setRate(rate: number): void {
  const clamped = Math.min(2.0, Math.max(0.75, rate));
  state.playbackRate = clamped;
  audioEl.playbackRate = clamped;
  pushState();
}

// Register Bluetooth headphone / macOS MediaSession hardware controls!
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => {
    if (!state.isPlaying) void togglePlayPause();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if (state.isPlaying) void togglePlayPause();
  });
  // Bluetooth Next/Prev track -> Skip to Next/Prev Podcast Topic Chapter!
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    void skipChapter(1);
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    void skipChapter(-1);
  });
  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    seekRelative(details.seekOffset || 15);
  });
  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    seekRelative(-(details.seekOffset || 15));
  });
}

chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
  switch (message?.type) {
    case 'OFFSCREEN_PLAY_EPISODE':
      activeEpisode = message.episode;
      setRate(message.rate);
      void loadAndPlayChapter(message.chapterIndex ?? 0).then(() => sendResponse({ ok: true }));
      return true;

    case 'OFFSCREEN_TOGGLE_PLAY_PAUSE':
      void togglePlayPause().then(() => sendResponse({ ok: true, state }));
      return true;

    case 'OFFSCREEN_SKIP_CHAPTER':
      void skipChapter(message.delta).then(() => sendResponse({ ok: true, state }));
      return true;

    case 'OFFSCREEN_SEEK_RELATIVE':
      seekRelative(message.deltaSec);
      sendResponse({ ok: true, state });
      return false;

    case 'OFFSCREEN_SET_RATE':
      setRate(message.rate);
      sendResponse({ ok: true, state });
      return false;

    case 'OFFSCREEN_GET_STATE':
      sendResponse({ ok: true, state });
      return false;

    case 'OFFSCREEN_RENDER_MP4':
      void (async () => {
        const episode = await db.episodes.get(message.episodeId);
        if (!episode) {
          sendResponse({ ok: false, error: 'エピソードが見つかりません。' });
          return;
        }
        const rendered = await renderEpisodeToMp4(episode);
        if (!rendered) {
          sendResponse({ ok: true, hasVideo: false });
          return;
        }
        await savePublishMedia({
          jobId: message.jobId,
          blob: rendered.blob,
          mimeType: 'video/mp4',
          fileName: rendered.fileName,
          sizeBytes: rendered.blob.size,
          createdAt: Date.now(),
        });
        sendResponse({
          ok: true,
          hasVideo: true,
          fileName: rendered.fileName,
          videoSizeBytes: rendered.blob.size,
          durationSec: rendered.durationSec,
        });
      })().catch((err: unknown) => {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return true;

    default:
      return false;
  }
});

// Keep-alive port so MV3 Service Worker never gets terminated mid-generation (30s idle cutoff)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'agentcast-keepalive') return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'PING') {
      try {
        port.postMessage({ type: 'PONG', ts: Date.now() });
      } catch {
        // port closed
      }
    }
  });
});
