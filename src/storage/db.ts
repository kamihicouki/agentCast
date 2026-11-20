import Dexie, { type Table } from 'dexie';
import {
  DEFAULT_PUBLISH_SETTINGS,
  DEFAULT_SETTINGS,
  type ExtractedCandidate,
  type ExtensionSettings,
  type FeedItem,
  type PodcastEpisode,
  type VideoDigest,
  type WatchTarget,
} from '../shared/types';
import { canonicalizeUrl, computeItemId, makeExcerpt } from '../shared/url-utils';

export interface ChapterAudioRecord {
  chapterKey: string; // `${episodeId}:${chapterIndex}`
  episodeId: string;
  chapterIndex: number;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: string;
}

class AgentCastDatabase extends Dexie {
  feedItems!: Table<FeedItem, string>;
  episodes!: Table<PodcastEpisode, string>;
  chapterAudio!: Table<ChapterAudioRecord, string>;
  watchTargets!: Table<WatchTarget, string>;
  videoDigests!: Table<VideoDigest, string>;

  constructor() {
    super('agentCastDB');
    this.version(1).stores({
      feedItems: 'id, canonicalUrl, source, capturedAt, consumedInEpisodeId',
      episodes: 'id, createdAt, status',
      chapterAudio: 'chapterKey, episodeId, chapterIndex',
    });
    // v0.4.0: follow radar targets + per-video digests
    this.version(2).stores({
      feedItems: 'id, canonicalUrl, source, capturedAt, consumedInEpisodeId',
      episodes: 'id, createdAt, status',
      chapterAudio: 'chapterKey, episodeId, chapterIndex',
      watchTargets: 'id, platform, enabled, status',
      videoDigests: 'videoId, createdAt',
    });
  }
}

export const db = new AgentCastDatabase();

const SETTINGS_STORAGE_KEY = 'agentcast_settings_v1';

export async function getSettings(): Promise<ExtensionSettings> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const saved = res[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      enabledSources: {
        ...DEFAULT_SETTINGS.enabledSources,
        ...(saved?.enabledSources ?? {}),
      },
      customSites: Array.isArray(saved?.customSites) ? saved.customSites : [],
      removedBuiltinSources: Array.isArray(saved?.removedBuiltinSources)
        ? saved.removedBuiltinSources
        : [],
      publish: {
        ...DEFAULT_PUBLISH_SETTINGS,
        ...(saved?.publish ?? {}),
      },
    };
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const merged: ExtensionSettings = {
    ...current,
    ...partial,
    enabledSources: {
      ...current.enabledSources,
      ...(partial.enabledSources ?? {}),
    },
    customSites: Array.isArray(partial.customSites)
      ? partial.customSites
      : current.customSites || [],
    removedBuiltinSources: Array.isArray(partial.removedBuiltinSources)
      ? partial.removedBuiltinSources
      : current.removedBuiltinSources || [],
    publish: {
      ...current.publish,
      ...(partial.publish ?? {}),
    },
  };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
  }
  return merged;
}

/**
 * Deduplicate and upsert extracted candidates into IndexedDB.
 * Returns the count of newly inserted unread items.
 */
export async function ingestCandidates(candidates: ExtractedCandidate[]): Promise<{
  inserted: number;
  updated: number;
  items: FeedItem[];
}> {
  const nowIso = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  const storedItems: FeedItem[] = [];

  for (const raw of candidates) {
    const cleanText = raw.content.replace(/\s+/g, ' ').trim();
    const cleanTitle = raw.title.replace(/\s+/g, ' ').trim();
    if (!cleanText && !cleanTitle) continue;
    if (cleanText.length < 24 && cleanTitle.length < 15) continue;

    const canonicalUrl = canonicalizeUrl(raw.url);
    const id = computeItemId(raw.source, canonicalUrl, cleanTitle);
    const existing = await db.feedItems.get(id);

    if (existing) {
      // Upgrade body if we previously only had a short headline/pickup and now fetched the full article
      if (cleanText.length > existing.content.length + 80) {
        const upgraded: FeedItem = {
          ...existing,
          title: cleanTitle || existing.title,
          content: cleanText,
          excerpt: makeExcerpt(cleanText),
          outboundUrls: Array.from(new Set([...existing.outboundUrls, ...raw.outboundUrls])),
        };
        await db.feedItems.put(upgraded);
        storedItems.push(upgraded);
        updated++;
      } else {
        storedItems.push(existing);
      }
      continue;
    }

    const item: FeedItem = {
      id,
      source: raw.source,
      url: raw.url,
      canonicalUrl,
      title: cleanTitle || makeExcerpt(cleanText, 64),
      author: raw.author || raw.source,
      authorHandle: raw.authorHandle,
      content: cleanText || cleanTitle,
      excerpt: makeExcerpt(cleanText || cleanTitle),
      outboundUrls: raw.outboundUrls.map((u) => canonicalizeUrl(u)),
      publishedAt: raw.publishedAt || nowIso,
      capturedAt: nowIso,
      engagementScore: raw.engagementScore ?? 1,
      consumedInEpisodeId: null,
    };

    await db.feedItems.put(item);
    storedItems.push(item);
    inserted++;
  }

  return { inserted, updated, items: storedItems };
}

export async function getUnreadQueue(limit = 60): Promise<FeedItem[]> {
  const all = await db.feedItems.orderBy('capturedAt').reverse().limit(250).toArray();
  return all.filter((item) => item.consumedInEpisodeId === null).slice(0, limit);
}

export async function markItemsConsumed(itemIds: string[], episodeId: string): Promise<void> {
  await db.transaction('rw', db.feedItems, async () => {
    for (const id of itemIds) {
      await db.feedItems.update(id, { consumedInEpisodeId: episodeId });
    }
  });
}

export function makeChapterKey(episodeId: string, chapterIndex: number): string {
  return `${episodeId}:${chapterIndex}`;
}
