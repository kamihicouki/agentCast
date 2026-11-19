import { db, makeChapterKey } from '../storage/db';
import { SOURCE_META, type PodcastEpisode } from './types';
import { mergeAudioBlobs } from './wav-utils';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 64);
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatEpisodeAsMarkdown(episode: PodcastEpisode): string {
  const lines: string[] = [
    `# ${episode.title}`,
    '',
    `> ${episode.subtitle}`,
    `> 生成日時: ${new Date(episode.createdAt).toLocaleString('ja-JP')} | ${episode.providerLabel} / ${episode.ttsEngineLabel}`,
    '',
  ];

  for (const ch of episode.chapters) {
    lines.push(`## ${ch.index + 1}. ${ch.title}`);
    if (ch.summary) {
      lines.push('', ch.summary);
    }
    if (ch.sourceItems.length > 0) {
      lines.push('', '### 参照リンク');
      for (const src of ch.sourceItems) {
        const badge = SOURCE_META[src.source]?.shortLabel || src.source;
        lines.push(`- [${badge}] [${src.title}](${src.url})`);
      }
    }
    lines.push('', '### 台本');
    for (const turn of ch.turns) {
      lines.push(`- **${turn.speakerName}**: ${turn.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function getMergedEpisodeAudio(
  episode: PodcastEpisode
): Promise<{ blob: Blob; mimeType: string; ext: 'wav' | 'mp3' } | null> {
  const blobs: Array<{ blob: Blob; mimeType: string }> = [];
  for (const ch of episode.chapters) {
    const rec = await db.chapterAudio.get(makeChapterKey(episode.id, ch.index));
    if (rec?.blob) {
      blobs.push({ blob: rec.blob, mimeType: rec.mimeType });
    }
  }
  if (blobs.length === 0) return null;
  return mergeAudioBlobs(blobs);
}

export async function downloadEpisodeAudio(episode: PodcastEpisode): Promise<boolean> {
  const merged = await getMergedEpisodeAudio(episode);
  if (!merged) return false;
  const filename = `${sanitizeFilename(episode.title)}.${merged.ext}`;
  triggerBrowserDownload(merged.blob, filename);
  return true;
}

export function downloadEpisodeMarkdown(episode: PodcastEpisode): void {
  const md = formatEpisodeAsMarkdown(episode);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  triggerBrowserDownload(blob, `${sanitizeFilename(episode.title)}.md`);
}

export async function copyEpisodeMarkdown(episode: PodcastEpisode): Promise<void> {
  const md = formatEpisodeAsMarkdown(episode);
  await navigator.clipboard.writeText(md);
}

/**
 * Generates a single self-contained HTML podcast file (embedded audio + chapters + transcript + source links)
 * that can be saved to Google Drive, AirDropped to iPhone, or shared with anyone to play in any browser.
 */
export async function downloadPortableHtmlPlayer(episode: PodcastEpisode): Promise<void> {
  const merged = await getMergedEpisodeAudio(episode);
  const audioDataUrl = merged ? await blobToDataUrl(merged.blob) : '';

  const chaptersHtml = episode.chapters
    .map((ch) => {
      const links = ch.sourceItems
        .map(
          (s) =>
            `<a class="chip" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">[${escapeHtml(
              SOURCE_META[s.source]?.shortLabel || s.source
            )}] ${escapeHtml(s.title)} ↗</a>`
        )
        .join('');
      const turns = ch.turns
        .map(
          (t) =>
            `<div class="turn"><span class="sp ${t.speaker === 'HostA' ? 'a' : 'b'}">${escapeHtml(
              t.speakerName
            )}</span><p>${escapeHtml(t.text)}</p></div>`
        )
        .join('');

      return `<section class="chapter">
        <h2>${ch.index + 1}. ${escapeHtml(ch.title)}</h2>
        ${ch.summary ? `<p class="summary">${escapeHtml(ch.summary)}</p>` : ''}
        ${links ? `<div class="links">${links}</div>` : ''}
        <div class="turns">${turns}</div>
      </section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(episode.title)} — agentCast</title>
<style>
  body{margin:0;background:#121417;color:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;line-height:1.65;padding:24px 16px 64px;}
  .wrap{max-width:740px;margin:0 auto;}
  header{background:#1a1d22;border:1px solid rgba(242,237,228,.12);border-radius:14px;padding:18px 20px;margin-bottom:20px;}
  h1{margin:0 0 6px;font-size:20px;}
  .sub{margin:0 0 12px;color:#b2aba0;font-size:13.5px;}
  audio{width:100%;margin-top:8px;}
  .chapter{background:#1a1d22;border:1px solid rgba(242,237,228,.09);border-radius:12px;padding:16px 18px;margin-bottom:16px;}
  .chapter h2{margin:0 0 6px;font-size:16px;color:#f2ede4;}
  .summary{margin:0 0 10px;color:#b2aba0;font-size:13px;}
  .links{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
  .chip{background:#22262d;color:#e7d8c2;text-decoration:none;font-size:12px;padding:4px 9px;border-radius:6px;border:1px solid rgba(242,237,228,.12);}
  .turn{padding:8px 10px;background:#15171c;border-radius:8px;margin-bottom:7px;}
  .sp{font-size:11.5px;font-weight:700;display:block;margin-bottom:2px;}
  .sp.a{color:#e56b43;} .sp.b{color:#50b081;}
  .turn p{margin:0;font-size:13.5px;}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(episode.title)}</h1>
      <p class="sub">${escapeHtml(episode.subtitle)}</p>
      ${
        audioDataUrl
          ? `<audio controls preload="metadata" src="${audioDataUrl}"></audio>`
          : `<p class="sub">※ このエピソードはローカルWeb Speechモードで生成されたため台本のみ含まれます。</p>`
      }
    </header>
    ${chaptersHtml}
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  triggerBrowserDownload(blob, `${sanitizeFilename(episode.title)}.html`);
}

export async function shareEpisodeNative(episode: PodcastEpisode): Promise<'shared' | 'copied'> {
  const md = formatEpisodeAsMarkdown(episode);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const merged = await getMergedEpisodeAudio(episode);
    if (merged) {
      const file = new File([merged.blob], `${sanitizeFilename(episode.title)}.${merged.ext}`, {
        type: merged.mimeType,
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: episode.title,
          text: episode.subtitle,
          files: [file],
        });
        return 'shared';
      }
    }

    await navigator.share({
      title: episode.title,
      text: md.slice(0, 4000),
    });
    return 'shared';
  }

  await copyEpisodeMarkdown(episode);
  return 'copied';
}
