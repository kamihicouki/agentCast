import type { TTSMode } from './types';

export interface ProgressSnapshot {
  percent: number;
  estimatedRemainingSec?: number;
}

/**
 * Rough initial estimate (in seconds) for LLM script generation based on item count and target duration.
 */
export function estimateScriptGenerationSec(itemCount: number, targetDurationMin: number): number {
  const safeItems = Math.max(1, Math.min(30, Math.round(itemCount || 1)));
  const safeMin = Math.max(3, Math.min(30, Math.round(targetDurationMin || 10)));
  return Math.max(15, Math.min(90, Math.round(12 + safeItems * 2 + safeMin * 1.4)));
}

/**
 * Rough initial estimate (in seconds) per chapter for cloud TTS synthesis.
 */
export function defaultChapterTtsSec(ttsMode: TTSMode): number {
  if (ttsMode === 'macos_speech') return 0;
  return ttsMode === 'gemini_tts' ? 14 : 10;
}

/**
 * Computes a smooth 0–100% progress value and optional ETA (seconds) across patrol -> script -> TTS -> done.
 */
export function computeJobProgress(
  phase: 'patrol' | 'script' | 'tts' | 'done',
  opts: {
    current?: number;
    total?: number;
    hasCloudTts?: boolean;
    estimatedScriptSec?: number;
    avgChapterTtsSec?: number;
  } = {}
): ProgressSnapshot {
  const hasCloudTts = opts.hasCloudTts !== false;

  if (phase === 'done') {
    return { percent: 100, estimatedRemainingSec: 0 };
  }

  if (phase === 'patrol') {
    const total = Math.max(1, opts.total || 1);
    const current = Math.max(0, Math.min(total, opts.current || 0));
    const ratio = current / total;
    const percent = Math.round(5 + ratio * 15); // 5% -> 20%
    return { percent };
  }

  if (phase === 'script') {
    const scriptSec = opts.estimatedScriptSec ?? 25;
    const estimatedChapters = 4;
    const ttsSec = hasCloudTts ? estimatedChapters * (opts.avgChapterTtsSec ?? 12) : 0;
    return {
      percent: 25,
      estimatedRemainingSec: Math.round(scriptSec + ttsSec),
    };
  }

  // phase === 'tts'
  const total = Math.max(1, opts.total || 1);
  const current = Math.max(0, Math.min(total, opts.current || 0));
  const ratio = current / total;
  // Script finished -> 45%, chapters complete -> 98%
  const percent = Math.min(98, Math.round(45 + ratio * 53));
  const remainingChapters = Math.max(0, total - current);
  const perChapterSec = Math.max(3, opts.avgChapterTtsSec ?? 12);
  const estimatedRemainingSec = Math.round(remainingChapters * perChapterSec);

  return { percent, estimatedRemainingSec };
}

/**
 * Formats estimated remaining seconds into a concise Japanese label (e.g. "残り約 45秒", "残り約 1分20秒").
 */
export function formatRemainingTime(sec?: number | null): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const rounded = Math.ceil(sec);
  if (rounded < 60) {
    return `残り約 ${rounded}秒`;
  }
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return s > 0 ? `残り約 ${m}分${s}秒` : `残り約 ${m}分`;
}

/**
 * Formats elapsed seconds into m:ss (e.g. "0:24", "2:05").
 */
export function formatElapsedTime(elapsedSec: number): string {
  const safe = Math.max(0, Math.floor(elapsedSec || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
