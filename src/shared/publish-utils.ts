import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { db } from '../storage/db';
import type { PodcastEpisode, PublishSettings } from './types';
import { mergeAudioBlobs } from './wav-utils';

export function extractYouTubeChannelId(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  // Direct UC... channel ID
  if (/^UC[0-9A-Za-z_-]{20,26}$/.test(trimmed)) {
    return trimmed;
  }

  // studio.youtube.com/channel/UC... or youtube.com/channel/UC...
  const match = /\/channel\/(UC[0-9A-Za-z_-]{20,26})/i.exec(trimmed);
  if (match?.[1]) {
    return match[1];
  }

  return null;
}

export function buildYouTubeStudioUploadUrl(channelIdOrUrl: string): string {
  const channelId = extractYouTubeChannelId(channelIdOrUrl);
  if (channelId) {
    return `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud`;
  }
  return 'https://studio.youtube.com/?d=ud';
}

function formatYtTimestamp(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateYmdHm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(
    2,
    '0'
  )}`;
}

export function buildYouTubeMetadata(
  episode: PodcastEpisode,
  publish: PublishSettings
): { title: string; description: string } {
  const dateStr = formatDateYmdHm(episode.createdAt);
  const title = `${episode.title}`.slice(0, 98);

  const lines: string[] = [];
  if (episode.subtitle) {
    lines.push(episode.subtitle);
    lines.push('');
  }
  lines.push(`収録日時: ${dateStr} / 生成: agentCast`);
  lines.push('');

  // YouTube Chapters (must start at 00:00)
  lines.push('【チャプター】');
  let offsetSec = 0;
  for (const ch of episode.chapters) {
    lines.push(`${formatYtTimestamp(offsetSec)} ${ch.title}`);
    offsetSec += Math.max(1, Math.round(ch.durationSec || 15)) + 0.6;
  }
  lines.push('');

  // Deduplicated source links
  const seenUrls = new Set<string>();
  const sourceLines: string[] = [];
  for (const ch of episode.chapters) {
    for (const src of ch.sourceItems) {
      if (!src.url || seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      sourceLines.push(`・${src.title}\n  ${src.url}`);
    }
  }
  if (sourceLines.length > 0) {
    lines.push('【参照リンク】');
    lines.push(...sourceLines.slice(0, 20));
    lines.push('');
  }

  if (publish.youtubeHashtags?.trim()) {
    lines.push(publish.youtubeHashtags.trim());
  }

  return {
    title,
    description: lines.join('\n').slice(0, 4900),
  };
}

export function buildXPostPayload(
  episode: PodcastEpisode,
  publish: PublishSettings
): { postText: string; threadReplyText: string } {
  const topicChapters = episode.chapters.filter(
    (c) => !/^(オープニング|導入|エンディング)[:：]?$/i.test(c.title.trim())
  );
  const highlights = (topicChapters.length > 0 ? topicChapters : episode.chapters)
    .slice(0, 3)
    .map((c) => `・${c.title.slice(0, 32)}`)
    .join('\n');

  const tags = publish.xHashtags?.trim() || '#agentCast';
  const rawPost = [
    `🎙 ${episode.title}`,
    episode.subtitle ? episode.subtitle.slice(0, 70) : '',
    highlights,
    tags,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Keep comfortably within standard X post length (~135 Japanese chars)
  const postText = rawPost.length > 138 ? `${rawPost.slice(0, 136)}…` : rawPost;

  const replyLines: string[] = ['【今回の参照リンク＆チャプター】'];
  const seen = new Set<string>();
  for (const ch of episode.chapters) {
    for (const src of ch.sourceItems) {
      if (!src.url || seen.has(src.url)) continue;
      seen.add(src.url);
      replyLines.push(`・${src.title.slice(0, 48)}\n${src.url}`);
    }
  }
  const threadReplyText = replyLines.slice(0, 8).join('\n');

  return { postText, threadReplyText };
}

export const MAX_PUBLISH_VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x4000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blobToArrayBuffer(blob)));
}

export async function readBlobChunkAsBase64(
  blob: Blob,
  offset: number,
  length: number
): Promise<{
  chunkBase64: string;
  offset: number;
  byteLength: number;
  totalBytes: number;
  done: boolean;
}> {
  const totalBytes = blob.size;
  const safeOffset = Math.max(0, Math.min(Math.floor(offset || 0), totalBytes));
  const requested = Math.floor(length || MAX_PUBLISH_VIDEO_CHUNK_BYTES);
  const safeLength = Math.max(1, Math.min(requested, MAX_PUBLISH_VIDEO_CHUNK_BYTES));
  const end = Math.min(totalBytes, safeOffset + safeLength);
  const slice = blob.slice(safeOffset, end);
  const bytes = new Uint8Array(await blobToArrayBuffer(slice));
  const nextOffset = safeOffset + bytes.byteLength;
  return {
    chunkBase64: bytesToBase64(bytes),
    offset: safeOffset,
    byteLength: bytes.byteLength,
    totalBytes,
    done: nextOffset >= totalBytes,
  };
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of Array.from(text)) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) break;
    } else {
      current = test;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (current && lines.length === maxLines) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  }
  return lines;
}

function drawStudioCoverCanvas(episode: PodcastEpisode): HTMLCanvasElement {
  const width = 1280;
  const height = 720;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Background warm dark charcoal gradient
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#16181d');
  bgGrad.addColorStop(1, '#0e1014');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle warm broadcast glow at top-left
  const glow = ctx.createRadialGradient(220, 120, 20, 220, 120, 520);
  glow.addColorStop(0, 'rgba(229, 107, 67, 0.24)');
  glow.addColorStop(1, 'rgba(229, 107, 67, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Editorial frame border
  ctx.strokeStyle = 'rgba(244, 239, 230, 0.14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, width - 72, height - 72);

  // Studio brand badge
  ctx.fillStyle = '#e56b43';
  ctx.beginPath();
  ctx.arc(88, 96, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f4efe6';
  ctx.font = '700 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
  ctx.fillText('agentCast', 112, 106);

  ctx.fillStyle = '#c4bdb1';
  ctx.font = '500 20px ui-monospace, SFMono-Regular, Menlo, monospace';
  const dateLabel = formatDateYmdHm(episode.createdAt);
  ctx.fillText(dateLabel, width - 310, 104);

  // Episode title
  ctx.fillStyle = '#f4efe6';
  ctx.font = '700 46px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
  const titleLines = wrapCanvasText(ctx, episode.title, width - 160, 2);
  let y = 190;
  for (const line of titleLines) {
    ctx.fillText(line, 80, y);
    y += 60;
  }

  // Analytical subtitle
  if (episode.subtitle) {
    ctx.fillStyle = '#d4cdc0';
    ctx.font = '400 24px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
    const subLines = wrapCanvasText(ctx, episode.subtitle, width - 160, 2);
    y += 10;
    for (const line of subLines) {
      ctx.fillText(line, 80, y);
      y += 36;
    }
  }

  // Divider
  y = Math.max(y + 18, 340);
  ctx.strokeStyle = 'rgba(229, 107, 67, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, y);
  ctx.lineTo(width - 80, y);
  ctx.stroke();

  // Chapter list with timestamps
  y += 42;
  ctx.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#e5a44d';
  ctx.fillText('CHAPTERS', 80, y);
  y += 36;

  let offsetSec = 0;
  for (const ch of episode.chapters.slice(0, 6)) {
    const ts = formatYtTimestamp(offsetSec);
    ctx.fillStyle = '#e56b43';
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(ts, 80, y);

    ctx.fillStyle = '#f4efe6';
    ctx.font = '500 23px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
    const chLabel = ch.title.length > 42 ? `${ch.title.slice(0, 41)}…` : ch.title;
    ctx.fillText(chLabel, 175, y);

    offsetSec += Math.max(1, Math.round(ch.durationSec || 15)) + 0.6;
    y += 40;
  }

  // Footer
  ctx.fillStyle = '#8b857b';
  ctx.font = '500 18px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';
  ctx.fillText('Personal AI Podcast · Generated with agentCast', 80, height - 64);

  return canvas;
}

/**
 * Fast WebCodecs MP4 renderer (H.264 1fps studio cover + AAC audio).
 * Encodes a 5-10 minute podcast in ~2-4 seconds directly in Chrome without external servers!
 */
export async function renderEpisodeToMp4(
  episode: PodcastEpisode,
  onProgress?: (msg: string) => void
): Promise<{ blob: Blob; fileName: string; durationSec: number } | null> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('このブラウザ環境は WebCodecs (VideoEncoder/AudioEncoder) に未対応です。');
  }

  onProgress?.('チャプター音声を結合中...');
  const records = await db.chapterAudio.where('episodeId').equals(episode.id).sortBy('chapterIndex');
  if (records.length === 0) {
    return null;
  }

  const merged = await mergeAudioBlobs(
    records.map((r) => ({ blob: r.blob, mimeType: r.mimeType }))
  );

  onProgress?.('音声データをデコード中...');
  const audioCtx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(await merged.blob.arrayBuffer());
  } finally {
    await audioCtx.close().catch(() => {});
  }

  const durationSec = Math.max(1, audioBuffer.duration);
  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = Math.min(2, audioBuffer.numberOfChannels);
  const width = 1280;
  const height = 720;

  onProgress?.('ポッドキャスト動画（MP4）を高速レンダリング中...');
  const coverCanvas = drawStudioCoverCanvas(episode);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: {
      codec: 'aac',
      numberOfChannels,
      sampleRate,
    },
    fastStart: 'in-memory',
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      throw err;
    },
  });

  videoEncoder.configure({
    codec: 'avc1.42001f',
    width,
    height,
    bitrate: 200_000,
    framerate: 1,
  });

  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => {
      throw err;
    },
  });

  audioEncoder.configure({
    codec: 'mp4a.40.2',
    numberOfChannels,
    sampleRate,
    bitrate: 96_000,
  });

  // 1. Encode 1fps studio cover video frames covering the full podcast duration
  const totalFrames = Math.ceil(durationSec);
  for (let sec = 0; sec < totalFrames; sec++) {
    const frame = new VideoFrame(coverCanvas, {
      timestamp: sec * 1_000_000,
      duration: 1_000_000,
    });
    videoEncoder.encode(frame, { keyFrame: sec === 0 || sec % 10 === 0 });
    frame.close();
  }

  // 2. Encode PCM audio in 1024-sample chunks (f32-planar)
  const chunkFrames = 1024;
  const totalSamples = audioBuffer.length;
  const channelsData: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    channelsData.push(audioBuffer.getChannelData(ch));
  }

  for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
    const frameCount = Math.min(chunkFrames, totalSamples - offset);
    const planar = new Float32Array(frameCount * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      planar.set(channelsData[ch].subarray(offset, offset + frameCount), ch * frameCount);
    }

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    audioEncoder.encode(audioData);
    audioData.close();
  }

  await videoEncoder.flush();
  await audioEncoder.flush();
  videoEncoder.close();
  audioEncoder.close();

  muxer.finalize();
  const { buffer } = muxer.target;
  const safeName = episode.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 48) || 'agentcast';
  const fileName = `${safeName}.mp4`;

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    fileName,
    durationSec,
  };
}
