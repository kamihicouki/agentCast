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
import { DATA_CONSENT_REQUIRED, SETTINGS_STORAGE_KEY } from '../shared/data-consent';

export interface ChapterAudioRecord {
  chapterKey: string; // `${episodeId}:${chapterIndex}`
  episodeId: string;
  chapterIndex: number;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: string;
}

export interface PublishMediaRecord {
  jobId: string;
  blob: Blob;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
}

class AgentCastDatabase extends Dexie {
  feedItems!: Table<FeedItem, string>;
  episodes!: Table<PodcastEpisode, string>;
  chapterAudio!: Table<ChapterAudioRecord, string>;
  watchTargets!: Table<WatchTarget, string>;
  videoDigests!: Table<VideoDigest, string>;
  credentialKeys!: Table<{ id: string; key: CryptoKey }, string>;
  publishMedia!: Table<PublishMediaRecord, string>;

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
    this.version(3).stores({ credentialKeys: 'id' });
    this.version(4).stores({ publishMedia: 'jobId, createdAt' });
  }
}

export const db = new AgentCastDatabase();

type ApiKeys = Pick<ExtensionSettings, 'geminiApiKey' | 'openaiApiKey'>;
interface EncryptedApiKeys {
  iv: number[];
  ciphertext: number[];
}

const CREDENTIAL_KEY_ID = 'settings-api-keys-v1';

async function encryptApiKeys(keys: ApiKeys): Promise<EncryptedApiKeys> {
  let entry = await db.credentialKeys.get(CREDENTIAL_KEY_ID);
  if (!entry) {
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt', 'decrypt',
    ]);
    entry = await db.transaction('rw', db.credentialKeys, async () => {
      const existing = await db.credentialKeys.get(CREDENTIAL_KEY_ID);
      if (existing) return existing;
      const created = { id: CREDENTIAL_KEY_ID, key: candidate };
      await db.credentialKeys.add(created);
      return created;
    });
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, entry.key, new TextEncoder().encode(JSON.stringify(keys))
  );
  return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(encrypted)) };
}

async function decryptApiKeys(envelope: EncryptedApiKeys): Promise<ApiKeys> {
  const entry = await db.credentialKeys.get(CREDENTIAL_KEY_ID);
  if (!entry) throw new Error('保存した API キーの暗号鍵が見つかりません。');
  const decoded = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(envelope.iv) },
    entry.key,
    Uint8Array.from(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decoded)) as ApiKeys;
}

export async function getSettings(): Promise<ExtensionSettings> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const res = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const { encryptedApiKeys, ...saved } = (res[SETTINGS_STORAGE_KEY] ?? {}) as
      Partial<ExtensionSettings> & { encryptedApiKeys?: EncryptedApiKeys };
    const apiKeys = encryptedApiKeys ? await decryptApiKeys(encryptedApiKeys) : undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      ...apiKeys,
      enabledSources: {
        ...DEFAULT_SETTINGS.enabledSources,
        ...(saved?.enabledSources ?? {}),
      },
      sourcePatrolDepth: {
        ...(saved?.sourcePatrolDepth ?? {}),
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
  if (DATA_CONSENT_REQUIRED) {
    return navigator.locks.request(SETTINGS_STORAGE_KEY, () => writeSettings(partial));
  }
  return writeSettings(partial);
}

export async function migrateLegacyApiKeys(): Promise<void> {
  if (!DATA_CONSENT_REQUIRED) return;
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = result[SETTINGS_STORAGE_KEY] as Partial<ApiKeys> | undefined;
  if (settings?.geminiApiKey || settings?.openaiApiKey) await saveSettings({});
}

async function writeSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const merged: ExtensionSettings = {
    ...current,
    ...partial,
    enabledSources: {
      ...current.enabledSources,
      ...(partial.enabledSources ?? {}),
    },
    sourcePatrolDepth: {
      ...(current.sourcePatrolDepth ?? {}),
      ...(partial.sourcePatrolDepth ?? {}),
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
    if (DATA_CONSENT_REQUIRED) {
      const { geminiApiKey, openaiApiKey, ...settings } = merged;
      const encryptedApiKeys = geminiApiKey || openaiApiKey
        ? await encryptApiKeys({ geminiApiKey, openaiApiKey })
        : undefined;
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: encryptedApiKeys ? { ...settings, encryptedApiKeys } : settings,
      });
    } else {
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
    }
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

export async function getUnreadQueue(limit = 500): Promise<FeedItem[]> {
  const all = await db.feedItems.orderBy('capturedAt').reverse().toArray();
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

export async function savePublishMedia(record: PublishMediaRecord): Promise<void> {
  await db.transaction('rw', db.publishMedia, async () => {
    await db.publishMedia.clear();
    await db.publishMedia.put(record);
  });
}

export async function getPublishMedia(jobId: string): Promise<PublishMediaRecord | undefined> {
  return db.publishMedia.get(jobId);
}

export async function clearPublishMedia(jobId?: string): Promise<void> {
  if (jobId) {
    await db.publishMedia.delete(jobId);
    return;
  }
  await db.publishMedia.clear();
}
