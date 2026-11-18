import type {
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
} from '../shared/types';
import { base64ToUint8Array, ensurePlayableAudioBlob } from '../shared/wav-utils';
import { buildPodcastScriptPrompt, parseGeneratedScriptJson } from './prompt-builder';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function generateScriptWithGemini(
  items: FeedItem[],
  settings: ExtensionSettings
): Promise<{ title: string; subtitle: string; chapters: EpisodeChapter[] }> {
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey) {
    throw new Error(
      'Gemini APIキーが未設定です。「設定」タブでキーを入力するか、「Webセッション連携モード（APIキー不要）」に切り替えてください。'
    );
  }

  const model = settings.geminiModel.trim() || 'gemini-flash-latest';
  const prompt = buildPodcastScriptPrompt(items, settings);

  const response = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
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
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini台本生成エラー (${response.status}): ${errBody.slice(0, 240)}`);
  }

  const data = await response.json();
  const textOut: string =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || '')
      .join('') || '';

  if (!textOut) {
    throw new Error('Gemini APIから空のレスポンスが返されました。');
  }

  return parseGeneratedScriptJson(textOut, items, settings);
}

async function requestGeminiTtsModel(
  apiKey: string,
  modelId: string,
  chapter: EpisodeChapter,
  settings: ExtensionSettings
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

  const response = await fetch(
    `${GEMINI_API_BASE}/${encodeURIComponent(modelId)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini TTS (${modelId}) HTTP ${response.status}: ${errText.slice(0, 220)}`);
  }

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
  settings: ExtensionSettings
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
      return await requestGeminiTtsModel(apiKey, candidateModel, chapter, settings);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini Multi-Speaker TTSの音声合成に失敗しました。');
}
