import type { DigestVerdict, ExtensionSettings, VideoDigest } from '../shared/types';
import {
  extractYouTubeVideoId,
  formatDurationSec,
  parseJson3Transcript,
  parseXmlTranscript,
  parseYtInitialPlayerResponse,
  pickCaptionTrack,
  type YouTubePlayerInfo,
} from '../extractors/youtube';

/**
 * Pluggable LLM runner so this module stays free of personal-only imports.
 * `videoUrl` is passed so Gemini API can fall back to native YouTube video understanding.
 */
export type DigestLlmRunner = (
  prompt: string,
  opts: { videoUrl?: string; useVideoInput?: boolean }
) => Promise<string>;

export interface VideoSourceMaterial {
  info: YouTubePlayerInfo;
  transcript: string;
}

const FETCH_HEADERS = { 'Accept-Language': 'ja,en;q=0.8' };

export async function fetchVideoSourceMaterial(videoUrl: string): Promise<VideoSourceMaterial> {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) throw new Error('YouTube動画のURLではありません。');

  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ja`, {
    headers: FETCH_HEADERS,
    credentials: 'include',
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`YouTube動画ページの取得に失敗しました (HTTP ${res.status})`);
  const html = await res.text();
  const info = parseYtInitialPlayerResponse(html);
  if (!info) throw new Error('動画情報を解析できませんでした（非公開・年齢制限・地域制限の可能性）。');

  let transcript = '';
  const track = pickCaptionTrack(info.captionTracks);
  if (track) {
    // Best-effort: YouTube may require a PO token for timedtext; failure falls back to description.
    try {
      const captionUrl = new URL(track.baseUrl);
      if (captionUrl.origin !== 'https://www.youtube.com') return { info, transcript };
      captionUrl.searchParams.set('fmt', 'json3');
      const capRes = await fetch(captionUrl, { credentials: 'include', redirect: 'error' });
      const body = capRes.ok ? await capRes.text() : '';
      if (body.trim().startsWith('{')) {
        transcript = parseJson3Transcript(JSON.parse(body));
      } else if (body.includes('<text')) {
        transcript = parseXmlTranscript(body);
      }
    } catch {
      transcript = '';
    }
  }
  return { info, transcript };
}

export function buildVideoDigestPrompt(
  material: VideoSourceMaterial,
  settings: Pick<ExtensionSettings, 'focusTopics'>,
  mode: 'transcript' | 'gemini_video' | 'description'
): string {
  const { info, transcript } = material;
  const body =
    mode === 'transcript'
      ? `## 字幕（タイムスタンプ付き）\n${transcript}`
      : mode === 'gemini_video'
        ? '## 添付の動画そのものを視聴して判断してください。'
        : `## 概要欄\n${info.description.slice(0, 5000) || '（概要なし）'}`;

  return [
    'あなたは忙しいユーザーの代わりにYouTube動画を事前チェックする編集者です。',
    '以下の動画を「見る価値があるか」判断できるよう、日本語で簡潔に要約してください。',
    `ユーザーの関心: ${settings.focusTopics || '特になし'}`,
    '',
    `タイトル: ${info.title}`,
    `チャンネル: ${info.author}`,
    `長さ: ${formatDurationSec(info.lengthSec) || '不明'}`,
    '',
    body,
    '',
    '次のJSONのみを出力してください（コードブロック不要）:',
    '{',
    '  "oneLiner": "30字以内で動画の核心",',
    '  "summary": ["要点を3〜5個の短文で"],',
    '  "keyPoints": [{"time": "mm:ss", "point": "その時刻で語られる重要ポイント"}],',
    '  "verdict": "watch | skim | skip のいずれか",',
    '  "verdictReason": "判断理由を1〜2文（関心との一致度・新規性・冗長さ）",',
    '  "relevance": 0から100の整数（ユーザー関心との関連度）',
    '}',
    mode === 'description'
      ? '※ 字幕が取得できなかったため概要欄のみからの推定です。keyPoints は概要欄のチャプター表記があれば使い、なければ空配列にしてください。'
      : '※ keyPoints は最大6個。時刻は実際の字幕/動画に基づくこと。',
  ].join('\n');
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseVideoDigestJson(
  text: string,
  material: VideoSourceMaterial,
  method: VideoDigest['method']
): VideoDigest {
  const obj = extractJsonObject(text);
  if (!obj) throw new Error('要約結果のJSONを解析できませんでした。');
  const verdictRaw = String(obj.verdict || '').toLowerCase();
  const verdict: DigestVerdict =
    verdictRaw.includes('watch') ? 'watch' : verdictRaw.includes('skip') ? 'skip' : 'skim';
  const summary = Array.isArray(obj.summary)
    ? obj.summary.map((s) => String(s)).filter(Boolean).slice(0, 6)
    : [];
  const keyPoints = Array.isArray(obj.keyPoints)
    ? obj.keyPoints
        .map((k) => {
          const kp = k as { time?: unknown; point?: unknown };
          return { time: String(kp.time || ''), point: String(kp.point || '') };
        })
        .filter((k) => k.point)
        .slice(0, 8)
    : [];
  const relevance = Math.max(0, Math.min(100, Math.round(Number(obj.relevance) || 50)));
  const { info } = material;
  return {
    videoId: info.videoId,
    url: `https://www.youtube.com/watch?v=${info.videoId}`,
    title: info.title,
    channelName: info.author,
    durationSec: info.lengthSec,
    oneLiner: String(obj.oneLiner || summary[0] || info.title).slice(0, 80),
    summary,
    keyPoints,
    verdict,
    verdictReason: String(obj.verdictReason || ''),
    relevance,
    method,
    createdAt: new Date().toISOString(),
  };
}

/** No-AI fallback: description chapters + keyword overlap with focus topics. */
export function buildHeuristicDigest(
  material: VideoSourceMaterial,
  focusTopics: string
): VideoDigest {
  const { info } = material;
  const desc = info.description || '';
  const chapterLines = desc
    .split('\n')
    .map((l) => /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .slice(0, 8)
    .map((m) => ({ time: m[1], point: m[2].trim() }));
  const keywords = focusTopics
    .split(/[・、,\s/]+/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length >= 2);
  const haystack = `${info.title} ${desc}`.toLowerCase();
  const hits = keywords.filter((k) => haystack.includes(k)).length;
  const relevance = keywords.length ? Math.min(100, Math.round((hits / keywords.length) * 100) + 20) : 50;
  const verdict: DigestVerdict = relevance >= 60 ? 'watch' : relevance >= 35 ? 'skim' : 'skip';
  const sentences = desc
    .replace(/https?:\/\/\S+/g, '')
    .split(/[\n。]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .slice(0, 3);
  return {
    videoId: info.videoId,
    url: `https://www.youtube.com/watch?v=${info.videoId}`,
    title: info.title,
    channelName: info.author,
    durationSec: info.lengthSec,
    oneLiner: info.title.slice(0, 60),
    summary: sentences.length ? sentences : ['概要欄に要約可能な説明がありません。'],
    keyPoints: chapterLines,
    verdict,
    verdictReason: `関心キーワード一致 ${hits}/${keywords.length || 0}（AI未設定のため簡易判定）`,
    relevance,
    method: 'heuristic',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Full digest pipeline: player response → transcript (best-effort) → LLM → JSON.
 * Fallback order: transcript → Gemini native video (gemini_api only) → description → heuristic.
 */
export async function summarizeYouTubeVideo(
  videoUrl: string,
  settings: ExtensionSettings,
  runLlm: DigestLlmRunner | null,
  onProgress?: (msg: string) => void
): Promise<VideoDigest> {
  onProgress?.('動画情報と字幕を取得中...');
  const material = await fetchVideoSourceMaterial(videoUrl);
  if (!runLlm) return buildHeuristicDigest(material, settings.focusTopics);

  const canonicalUrl = `https://www.youtube.com/watch?v=${material.info.videoId}`;
  const attempts: Exclude<VideoDigest['method'], 'heuristic'>[] = [];
  if (material.transcript.length > 200) attempts.push('transcript');
  if (settings.geminiApiKey.trim() && settings.aiMode !== 'openai_api') attempts.push('gemini_video');
  attempts.push('description');

  let lastErr: unknown;
  for (const method of attempts) {
    try {
      onProgress?.(
        method === 'transcript'
          ? `字幕 ${material.transcript.length.toLocaleString()}字 から要約中...`
          : method === 'gemini_video'
            ? 'Gemini で動画そのものを解析中...'
            : '概要欄から要約中...'
      );
      const prompt = buildVideoDigestPrompt(material, settings, method);
      const out = await runLlm(prompt, {
        videoUrl: canonicalUrl,
        useVideoInput: method === 'gemini_video',
      });
      return parseVideoDigestJson(out, material, method);
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn('[agentCast] video digest LLM failed, using heuristic:', lastErr);
  return buildHeuristicDigest(material, settings.focusTopics);
}
