import type {
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
} from '../shared/types';
import { ensurePlayableAudioBlob } from '../shared/wav-utils';
import { buildPodcastScriptPrompt, parseGeneratedScriptJson } from './prompt-builder';

export async function generateScriptWithOpenAI(
  items: FeedItem[],
  settings: ExtensionSettings
): Promise<{ title: string; subtitle: string; chapters: EpisodeChapter[] }> {
  const apiKey = settings.openaiApiKey.trim();
  if (!apiKey) {
    throw new Error(
      'OpenAI APIキーが未設定です。「設定」タブでキーを入力するか、「Webセッション連携モード（ChatGPT Plus/Pro）」を選択してください。'
    );
  }

  const model = settings.openaiModel.trim() || 'gpt-4o-mini';
  const prompt = buildPodcastScriptPrompt(items, settings);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: 'あなたはJSONのみを出力する日本語ポッドキャスト番組構成AIです。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI台本生成エラー (${response.status}): ${errText.slice(0, 220)}`);
  }

  const data = await response.json();
  const content: string = data?.choices?.[0]?.message?.content || '';
  if (!content) {
    throw new Error('OpenAI APIから空のレスポンスが返されました。');
  }

  return parseGeneratedScriptJson(content, items, settings);
}

export async function generateTextWithOpenAI(
  prompt: string,
  settings: ExtensionSettings
): Promise<string> {
  const apiKey = settings.openaiApiKey.trim();
  if (!apiKey) throw new Error('OpenAI APIキーが未設定です。');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: settings.openaiModel.trim() || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'あなたはJSONのみを出力する日本語アシスタントです。' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI APIエラー (${response.status}): ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const content: string = data?.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('OpenAI APIから空のレスポンスが返されました。');
  return content;
}

export async function synthesizeChapterWithOpenAITts(
  chapter: EpisodeChapter,
  settings: ExtensionSettings
): Promise<{ blob: Blob; durationSec: number; mimeType: string }> {
  const apiKey = settings.openaiApiKey.trim();
  if (!apiKey) {
    throw new Error('OpenAI TTS用のAPIキーが設定されていません。');
  }

  const mp3Chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (const turn of chapter.turns) {
    const voice = turn.speaker === 'HostA' ? 'onyx' : 'nova';
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice,
        response_format: 'mp3',
        input: turn.spokenText || turn.text,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI TTSエラー (${res.status}): ${errText.slice(0, 180)}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    mp3Chunks.push(buf);
    totalBytes += buf.byteLength;
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return ensurePlayableAudioBlob(combined, 'audio/mpeg');
}
