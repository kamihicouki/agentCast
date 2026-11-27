import { requireDataConsent } from '../shared/data-consent';
import type {
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
} from '../shared/types';
import { base64ToUint8Array, ensurePlayableAudioBlob } from '../shared/wav-utils';
import {
  buildPodcastScriptPrompt,
  parseGeneratedScriptJson,
  type ScriptPromptOptions,
} from './prompt-builder';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const SCRIPT_TIMEOUT_MS = 90_000;
const TEXT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 60_000;
const SCRIPT_FALLBACK_MODEL = 'gemini-2.5-flash';

export interface GeminiRetryOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  onProgress?: (detail: string) => void;
  context?: string;
}

export class GeminiHttpError extends Error {
  status: number;
  rawBody: string;
  retryable: boolean;

  constructor(status: number, rawBody: string, context: string) {
    super(formatFriendlyGeminiError(status, rawBody, context));
    this.name = 'GeminiHttpError';
    this.status = status;
    this.rawBody = rawBody;
    this.retryable = RETRYABLE_HTTP_STATUSES.has(status);
  }
}

export function formatFriendlyGeminiError(status: number, rawBody: string, context: string): string {
  if (status === 503) {
    return `${context}エラー (503): Geminiサーバーが混雑しています。しばらく待ってから再試行するか、「設定」タブで別のモデル（例: gemini-2.5-flash）に変更してお試しください。`;
  }
  if (status === 429) {
    return `${context}エラー (429): Gemini API の利用上限（レート制限）に達しました。少し時間をおいてから再試行してください。`;
  }
  if (status === 401 || status === 403) {
    return `${context}エラー (${status}): Gemini APIキーが無効か権限がありません。「設定」タブでAPIキーをご確認ください。`;
  }
  return `${context}エラー (${status}): ${rawBody.slice(0, 220)}`;
}

function isRetryableNetworkOrTimeoutError(err: unknown): boolean {
  if (err instanceof GeminiHttpError) return err.retryable;
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (/network|failed to fetch|load failed|timed? out/i.test(err.message)) return true;
  }
  return false;
}

export async function fetchGeminiWithRetry(
  url: string,
  init: RequestInit,
  opts: GeminiRetryOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? TEXT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const context = opts.context || 'Gemini API';

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        return response;
      }

      const errBody = await response.text().catch(() => '');
      const httpErr = new GeminiHttpError(response.status, errBody, context);
      lastError = httpErr;

      if (!httpErr.retryable || attempt >= maxRetries) {
        throw httpErr;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      opts.onProgress?.(
        response.status === 503
          ? `Geminiサーバー混雑 (503) のため ${Math.round(delayMs / 1000)}秒後に再試行 (${attempt + 1}/${maxRetries})...`
          : `Gemini応答エラー (${response.status}) のため再試行中 (${attempt + 1}/${maxRetries})...`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      if (err instanceof GeminiHttpError) {
        if (!err.retryable || attempt >= maxRetries) throw err;
        lastError = err;
        continue;
      }

      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const wrapped = isAbort
        ? new Error(
            `${context}がタイムアウトしました (${Math.round(timeoutMs / 1000)}秒)。通信状況を確認するか、記事数を減らして再度お試しください。`
          )
        : err;
      lastError = wrapped;

      if (!isRetryableNetworkOrTimeoutError(err) || attempt >= maxRetries) {
        throw wrapped;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      opts.onProgress?.(
        isAbort
          ? `応答タイムアウトのため再試行中 (${attempt + 1}/${maxRetries})...`
          : `通信エラーのため再試行中 (${attempt + 1}/${maxRetries})...`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${context}に失敗しました。`);
}

function extractGeminiResponseText(data: unknown): string {
  const parts = (
    data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
    }
  )?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const nonThought = parts
    .filter((p) => !p?.thought && typeof p?.text === 'string')
    .map((p) => p.text || '')
    .join('');
  if (nonThought.trim()) return nonThought;
  return parts.map((p) => p?.text || '').join('');
}

export async function generateScriptWithGemini(
  items: FeedItem[],
  settings: ExtensionSettings,
  promptOpts?: ScriptPromptOptions,
  retryOpts?: Pick<GeminiRetryOptions, 'timeoutMs' | 'maxRetries' | 'baseDelayMs' | 'onProgress'>
): Promise<{ title: string; subtitle: string; chapters: EpisodeChapter[] }> {
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey) {
    throw new Error(
      'Gemini APIキーが未設定です。「設定」タブでキーを入力するか、「Webセッション連携モード（APIキー不要）」に切り替えてください。'
    );
  }

  const primaryModel = settings.geminiModel.trim() || 'gemini-flash-latest';
  const candidateModels = [primaryModel];
  if (primaryModel !== SCRIPT_FALLBACK_MODEL) {
    candidateModels.push(SCRIPT_FALLBACK_MODEL);
  }

  const prompt = buildPodcastScriptPrompt(items, settings, promptOpts);
  await requireDataConsent();

  let lastError: unknown;
  for (let i = 0; i < candidateModels.length; i++) {
    const model = candidateModels[i];
    if (i > 0) {
      retryOpts?.onProgress?.(`混雑のため代替モデル (${model}) に切り替えて台本を生成中...`);
    }

    try {
      const response = await fetchGeminiWithRetry(
        `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.5,
            },
          }),
        },
        {
          timeoutMs: retryOpts?.timeoutMs ?? SCRIPT_TIMEOUT_MS,
          maxRetries: retryOpts?.maxRetries ?? 2,
          baseDelayMs: retryOpts?.baseDelayMs ?? 2000,
          onProgress: retryOpts?.onProgress,
          context: 'Gemini台本生成',
        }
      );

      const data = await response.json();
      const textOut = extractGeminiResponseText(data);

      if (!textOut) {
        throw new Error('Gemini APIから空のレスポンスが返されました。');
      }

      return parseGeneratedScriptJson(textOut, items, settings);
    } catch (err) {
      lastError = err;
      const canFallback = i + 1 < candidateModels.length && isRetryableNetworkOrTimeoutError(err);
      if (!canFallback) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Gemini台本生成に失敗しました。');
}

/**
 * Generic JSON-mode request. `extraParts` lets callers attach e.g.
 * `{ fileData: { fileUri: 'https://www.youtube.com/watch?v=…' } }` for native video understanding.
 */
export async function generateTextWithGemini(
  prompt: string,
  settings: ExtensionSettings,
  extraParts: Record<string, unknown>[] = []
): Promise<string> {
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey) throw new Error('Gemini APIキーが未設定です。');
  const model = settings.geminiModel.trim() || 'gemini-flash-latest';
  await requireDataConsent();
  const response = await fetchGeminiWithRetry(
    `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [...extraParts, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }),
    },
    {
      timeoutMs: TEXT_TIMEOUT_MS,
      maxRetries: 2,
      context: 'Gemini API',
    }
  );
  const data = await response.json();
  const textOut = extractGeminiResponseText(data);
  if (!textOut) throw new Error('Gemini APIから空のレスポンスが返されました。');
  return textOut;
}

async function requestGeminiTtsModel(
  apiKey: string,
  modelId: string,
  chapter: EpisodeChapter,
  settings: ExtensionSettings,
  retryOpts?: Pick<GeminiRetryOptions, 'timeoutMs' | 'maxRetries' | 'baseDelayMs' | 'onProgress'>
): Promise<{ blob: Blob; durationSec: number; mimeType: string }> {
  const isV38Model = modelId.includes('3.8') || modelId.includes('3.1');

  // Gemini 3.8 TTS uses per-turn parts with speechMetadata.speaker and forbids temperature/systemInstruction.
  // Earlier 2.5 TTS models use speaker-prefixed lines in a single text part.
  const contents = isV38Model
    ? [
        {
          role: 'user',
          parts: chapter.turns.map((turn) => ({
            text: turn.spokenText || turn.text,
            speechMetadata: {
              speaker: turn.speaker,
            },
          })),
        },
      ]
    : [
        {
          role: 'user',
          parts: [
            {
              text: [
                '以下の2人のラジオパーソナリティによる日本語の掛け合いを、自然で親しみやすいトーンで読み上げてください。',
                ...chapter.turns.map((t) => `${t.speaker}: ${t.spokenText || t.text}`),
              ].join('\n'),
            },
          ],
        },
      ];

  const payload = {
    contents,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            {
              speaker: 'HostA',
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: settings.hostAVoice || 'Puck',
                },
              },
            },
            {
              speaker: 'HostB',
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: settings.hostBVoice || 'Aoede',
                },
              },
            },
          ],
        },
      },
    },
  };

  await requireDataConsent();
  const response = await fetchGeminiWithRetry(
    `${GEMINI_API_BASE}/${encodeURIComponent(modelId)}:generateContent`,
    {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    },
    {
      timeoutMs: retryOpts?.timeoutMs ?? TTS_TIMEOUT_MS,
      maxRetries: retryOpts?.maxRetries ?? 2,
      baseDelayMs: retryOpts?.baseDelayMs ?? 2000,
      onProgress: retryOpts?.onProgress,
      context: `Gemini TTS (${modelId})`,
    }
  );

  const data = await response.json();
  const inlinePart = data?.candidates?.[0]?.content?.parts?.find(
    (p: { inlineData?: { data?: string; mimeType?: string } }) => p.inlineData?.data
  );

  if (!inlinePart?.inlineData?.data) {
    throw new Error(`Gemini TTS (${modelId}) から音声データが返されませんでした。`);
  }

  const rawBytes = base64ToUint8Array(inlinePart.inlineData.data);
  const mimeType: string = inlinePart.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000';
  return ensurePlayableAudioBlob(rawBytes, mimeType);
}

export async function synthesizeChapterWithGeminiTts(
  chapter: EpisodeChapter,
  settings: ExtensionSettings,
  retryOpts?: Pick<GeminiRetryOptions, 'timeoutMs' | 'maxRetries' | 'baseDelayMs' | 'onProgress'>
): Promise<{ blob: Blob; durationSec: number; mimeType: string }> {
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey) {
    throw new Error('Gemini TTS用のAPIキーが設定されていません。');
  }

  const primaryModel = settings.geminiTtsModel.trim() || 'gemini-3.8-flash-tts';
  const fallbackModels = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts'].filter(
    (m) => m !== primaryModel
  );

  let lastError: unknown;
  for (const candidateModel of [primaryModel, ...fallbackModels]) {
    try {
      return await requestGeminiTtsModel(apiKey, candidateModel, chapter, settings, retryOpts);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini Multi-Speaker TTSの音声合成に失敗しました。');
}
