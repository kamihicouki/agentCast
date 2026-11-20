/**
 * Follow radar (登録チャンネル・フォロー動向レーダー).
 *
 * - YouTube: zero-tab check through each channel's public RSS feed (feeds/videos.xml).
 * - X.com: visits https://x.com/<handle> in the grouped patrol tab with the user's own session,
 *   capped per run and spaced with human-like delays.
 * - Import: reads the signed-in subscriptions list (/feed/channels) and X following list.
 */
import { db, getSettings } from '../../storage/db';
import type { ExtractionResultPayload } from '../../shared/messages';
import type {
  ExtractedCandidate,
  RadarItem,
  VideoDigest,
  WatchTarget,
} from '../../shared/types';
import {
  applyRadarResult,
  formatRelativeJa,
  makeWatchTargetId,
  normalizeXHandle,
  normalizeYouTubeChannelInput,
} from '../../shared/radar-utils';
import { extractChannelIdFromHtml, formatDurationSec, parseYouTubeChannelRss } from '../../extractors/youtube';

export interface RadarDeps {
  updateJobProgress: (msg: string) => void;
  broadcastEvent: (payload: Record<string, unknown>) => void;
  openPatrolTab: (url: string) => Promise<number>;
  waitForTabReady: (tabId: number, timeoutMs?: number) => Promise<void>;
  extractFromTab: (tabId: number, scrollSteps?: number) => Promise<ExtractionResultPayload>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newTarget(partial: Partial<WatchTarget> & Pick<WatchTarget, 'id' | 'platform' | 'name' | 'url'>): WatchTarget {
  return {
    enabled: true,
    addedAt: new Date().toISOString(),
    lastSeenItemIds: [],
    newCount: 0,
    latestItems: [],
    status: 'unknown',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Manual add
// ---------------------------------------------------------------------------

export async function addWatchTarget(
  platform: WatchTarget['platform'],
  input: string,
  name?: string
): Promise<WatchTarget> {
  if (platform === 'x') {
    const handle = normalizeXHandle(input);
    if (!handle) throw new Error('Xのハンドル（例: @openai または https://x.com/openai）を入力してください。');
    const id = makeWatchTargetId('x', handle);
    const existing = await db.watchTargets.get(id);
    if (existing) return existing;
    const target = newTarget({ id, platform: 'x', name: name?.trim() || `@${handle}`, url: `https://x.com/${handle}`, handle });
    await db.watchTargets.put(target);
    return target;
  }

  const norm = normalizeYouTubeChannelInput(input);
  if (!norm) throw new Error('YouTubeチャンネルURL（@handle / channel/UC…）を入力してください。');
  let channelId = norm.channelId;
  let resolvedName = name?.trim() || norm.handle || '';
  if (!channelId) {
    channelId = await resolveYouTubeChannelId(norm.url);
  }
  if (channelId && !name) {
    try {
      const rss = await fetchYouTubeRss(channelId);
      resolvedName = rss.channelTitle || resolvedName;
    } catch {
      // name stays as handle
    }
  }
  const id = makeWatchTargetId('youtube', channelId || norm.handle || norm.url);
  const existing = await db.watchTargets.get(id);
  if (existing) return existing;
  const target = newTarget({
    id,
    platform: 'youtube',
    name: resolvedName || norm.url,
    url: norm.url,
    channelId,
    handle: norm.handle,
  });
  await db.watchTargets.put(target);
  return target;
}

// ---------------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------------

async function resolveYouTubeChannelId(channelUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(channelUrl, { credentials: 'omit', headers: { 'Accept-Language': 'ja' } });
    if (!res.ok) return undefined;
    return extractChannelIdFromHtml(await res.text());
  } catch {
    return undefined;
  }
}

async function fetchYouTubeRss(channelId: string) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  return parseYouTubeChannelRss(await res.text());
}

async function checkYouTubeTarget(target: WatchTarget, windowHours: number): Promise<WatchTarget> {
  try {
    let channelId = target.channelId;
    if (!channelId) {
      channelId = await resolveYouTubeChannelId(target.url);
      if (!channelId) {
        return { ...target, status: 'error', statusMessage: 'チャンネルIDを解決できませんでした', lastCheckedAt: new Date().toISOString() };
      }
    }
    const rss = await fetchYouTubeRss(channelId);
    const updated = applyRadarResult({ ...target, channelId }, rss.items, { windowHours });
    return { ...updated, name: target.name || rss.channelTitle };
  } catch (err) {
    return {
      ...target,
      status: 'error',
      statusMessage: err instanceof Error ? err.message : String(err),
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Radar check
// ---------------------------------------------------------------------------

export async function runRadarCheck(
  deps: RadarDeps,
  opts: { platforms?: WatchTarget['platform'][] } = {}
): Promise<{ active: number; quiet: number; errors: number; warnings: string[] }> {
  const settings = await getSettings();
  const windowHours = settings.radarWindowHours || 72;
  const platforms = opts.platforms ?? ['youtube', 'x'];
  const all = (await db.watchTargets.toArray()).filter((t) => t.enabled && platforms.includes(t.platform));
  const warnings: string[] = [];

  // 1. YouTube — public RSS, parallel, no tabs
  const ytTargets = all.filter((t) => t.platform === 'youtube');
  let done = 0;
  await runWithConcurrency(ytTargets, 6, async (t) => {
    const updated = await checkYouTubeTarget(t, windowHours);
    await db.watchTargets.put(updated);
    done++;
    deps.updateJobProgress(`YouTube 登録チャンネルを確認中 (${done}/${ytTargets.length})…`);
    if (done % 6 === 0) deps.broadcastEvent({ type: 'RADAR_UPDATED' });
  });
  deps.broadcastEvent({ type: 'RADAR_UPDATED' });

  // 2. X — tab-based, oldest-checked first, capped per run
  const xTargets = all
    .filter((t) => t.platform === 'x' && t.handle)
    .sort((a, b) => (Date.parse(a.lastCheckedAt || '') || 0) - (Date.parse(b.lastCheckedAt || '') || 0))
    .slice(0, Math.max(1, settings.radarMaxXAccountsPerRun || 12));

  if (xTargets.length > 0) {
    const tabId = await deps.openPatrolTab('about:blank');
    try {
      for (let i = 0; i < xTargets.length; i++) {
        const t = xTargets[i];
        deps.updateJobProgress(`X フォロー先を確認中 (${i + 1}/${xTargets.length}): @${t.handle}`);
        await chrome.tabs.update(tabId, { url: `https://x.com/${t.handle}` });
        await deps.waitForTabReady(tabId, 16000);
        await sleep(2200 + Math.floor(Math.random() * 800));
        const extracted = await deps.extractFromTab(tabId, 1);
        if (extracted.blocked) {
          await db.watchTargets.put({
            ...t,
            status: 'error',
            statusMessage: extracted.blockMessage || 'ログインが必要です',
            lastCheckedAt: new Date().toISOString(),
          });
          warnings.push(`X: ${extracted.blockMessage || 'ログインが必要なため確認を中断しました'}`);
          break;
        }
        const handleLower = `@${t.handle!.toLowerCase()}`;
        const own = extracted.candidates.filter(
          (c) => !c.authorHandle || c.authorHandle.toLowerCase() === handleLower
        );
        const items: RadarItem[] = own.map((c) => ({
          id: c.url,
          title: c.content.split('\n')[0].slice(0, 90),
          url: c.url,
          publishedAt: c.publishedAt,
          excerpt: c.content.slice(0, 280),
        }));
        if (extracted.candidates.length === 0) {
          await db.watchTargets.put({
            ...t,
            status: 'error',
            statusMessage: 'ポストを読み取れませんでした（非公開/凍結/読み込み遅延）',
            lastCheckedAt: new Date().toISOString(),
          });
        } else {
          await db.watchTargets.put(applyRadarResult(t, items, { windowHours }));
        }
        deps.broadcastEvent({ type: 'RADAR_UPDATED' });
        await sleep(900 + Math.floor(Math.random() * 900));
      }
    } finally {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }

  const refreshed = (await db.watchTargets.toArray()).filter((t) => t.enabled);
  await chrome.storage.local.set({ agentcast_radar_last_run: new Date().toISOString() });
  deps.broadcastEvent({ type: 'RADAR_UPDATED' });
  return {
    active: refreshed.filter((t) => t.status === 'active').length,
    quiet: refreshed.filter((t) => t.status === 'quiet').length,
    errors: refreshed.filter((t) => t.status === 'error').length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Import (self-contained funcs injected with chrome.scripting.executeScript)
// ---------------------------------------------------------------------------

async function scrapeYouTubeChannelList(): Promise<{ loginRequired: boolean; channels: { name: string; href: string }[] }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const signIn = document.querySelector('ytd-masthead a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[href*="ServiceLogin"]');
  if (signIn && !document.querySelector('#avatar-btn, button#avatar-btn')) {
    return { loginRequired: true, channels: [] };
  }
  const map = new Map<string, string>();
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const before = map.size;
    document.querySelectorAll('ytd-channel-renderer').forEach((el) => {
      const a = el.querySelector<HTMLAnchorElement>('a#main-link, a.channel-link, a[href^="/@"], a[href^="/channel/"]');
      const href = a?.getAttribute('href') || '';
      const name = (el.querySelector('#channel-title #text, #text.ytd-channel-name, #channel-title')?.textContent || '').trim();
      if (href && name) map.set(href, name);
    });
    stable = map.size === before ? stable + 1 : 0;
    window.scrollBy(0, window.innerHeight * 2);
    await wait(900);
  }
  return { loginRequired: false, channels: Array.from(map, ([href, name]) => ({ href, name })) };
}

async function scrapeXFollowing(maxCount: number): Promise<{ loginRequired: boolean; users: { handle: string; name: string }[] }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (location.pathname.startsWith('/i/flow/login') || document.querySelector('[data-testid="loginButton"]')) {
    return { loginRequired: true, users: [] };
  }
  const map = new Map<string, string>();
  let stable = 0;
  for (let i = 0; i < 60 && stable < 4 && map.size < maxCount; i++) {
    const before = map.size;
    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      const links = Array.from(cell.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'));
      const profile = links.find((a) => /^\/[A-Za-z0-9_]{1,15}$/.test(a.getAttribute('href') || ''));
      const handle = profile?.getAttribute('href')?.slice(1);
      if (!handle) return;
      const name = (profile?.textContent || '').replace(/@\w+/, '').trim() || handle;
      map.set(handle, name);
    });
    stable = map.size === before ? stable + 1 : 0;
    window.scrollBy(0, window.innerHeight * 1.6);
    await wait(1100 + Math.floor(Math.random() * 500));
  }
  return { loginRequired: false, users: Array.from(map, ([handle, name]) => ({ handle, name })).slice(0, maxCount) };
}

function readOwnXHandle(): string | null {
  const href = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href') || '';
  const m = /^\/([A-Za-z0-9_]{1,15})$/.exec(href);
  return m ? m[1] : null;
}

export async function importYouTubeSubscriptions(deps: RadarDeps): Promise<{ added: number; total: number }> {
  deps.updateJobProgress('YouTube 登録チャンネル一覧を読み取り中…');
  const tabId = await deps.openPatrolTab('https://www.youtube.com/feed/channels');
  try {
    await deps.waitForTabReady(tabId, 18000);
    await sleep(2500);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeYouTubeChannelList });
    const payload = res?.result;
    if (!payload) throw new Error('登録チャンネル一覧を読み取れませんでした。');
    if (payload.loginRequired) throw new Error('YouTube にログインしてから再実行してください。');

    let added = 0;
    for (let i = 0; i < payload.channels.length; i++) {
      const ch = payload.channels[i];
      const url = new URL(ch.href, 'https://www.youtube.com').toString();
      const norm = normalizeYouTubeChannelInput(url);
      if (!norm) continue;
      const key = norm.channelId || norm.handle || norm.url;
      const id = makeWatchTargetId('youtube', key);
      // Avoid duplicates across handle/UC ids
      const dup = (await db.watchTargets.get(id)) || (await db.watchTargets.where('platform').equals('youtube').filter((t) => t.url === norm.url).first());
      if (dup) continue;
      await db.watchTargets.put(
        newTarget({ id, platform: 'youtube', name: ch.name, url: norm.url, channelId: norm.channelId, handle: norm.handle })
      );
      added++;
      if (i % 10 === 0) deps.updateJobProgress(`登録チャンネルを取り込み中 (${i + 1}/${payload.channels.length})…`);
    }
    deps.broadcastEvent({ type: 'RADAR_UPDATED' });
    return { added, total: payload.channels.length };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

export async function importXFollowing(deps: RadarDeps, maxCount = 300): Promise<{ added: number; total: number; handle: string }> {
  const settings = await getSettings();
  let handle = normalizeXHandle(settings.publish?.xAccountHandle || '') || '';
  const tabId = await deps.openPatrolTab(handle ? `https://x.com/${handle}/following` : 'https://x.com/home');
  try {
    await deps.waitForTabReady(tabId, 18000);
    await sleep(2500);
    if (!handle) {
      deps.updateJobProgress('X のログインアカウントを確認中…');
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: readOwnXHandle });
      handle = r?.result || '';
      if (!handle) throw new Error('X にログインしているアカウントを特定できませんでした（設定 → 公開先のXハンドルを入力してください）。');
      await chrome.tabs.update(tabId, { url: `https://x.com/${handle}/following` });
      await deps.waitForTabReady(tabId, 18000);
      await sleep(2500);
    }
    deps.updateJobProgress(`@${handle} のフォロー一覧を読み取り中…`);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeXFollowing, args: [maxCount] });
    const payload = res?.result;
    if (!payload) throw new Error('フォロー一覧を読み取れませんでした。');
    if (payload.loginRequired) throw new Error('X にログインしてから再実行してください。');

    let added = 0;
    for (const u of payload.users) {
      const id = makeWatchTargetId('x', u.handle);
      if (await db.watchTargets.get(id)) continue;
      // X accounts are imported disabled: tab-based checks are slower, so the user picks which to watch.
      await db.watchTargets.put(
        newTarget({ id, platform: 'x', name: u.name, url: `https://x.com/${u.handle}`, handle: u.handle, enabled: false })
      );
      added++;
    }
    deps.broadcastEvent({ type: 'RADAR_UPDATED' });
    return { added, total: payload.users.length, handle };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Episode material
// ---------------------------------------------------------------------------

export function buildRadarCandidates(
  targets: WatchTarget[],
  digests: Map<string, VideoDigest>,
  now = Date.now()
): ExtractedCandidate[] {
  const enabled = targets.filter((t) => t.enabled && t.lastCheckedAt);
  const active = enabled.filter((t) => t.status === 'active');
  const quiet = enabled.filter((t) => t.status === 'quiet');
  const out: ExtractedCandidate[] = [];

  for (const t of active) {
    for (const item of t.latestItems.slice(0, t.newCount || 1).slice(0, 3)) {
      if (t.platform === 'youtube') {
        const vid = /[?&]v=([\w-]{11})/.exec(item.url)?.[1];
        const d = vid ? digests.get(vid) : undefined;
        const digestText = d
          ? `要約: ${d.oneLiner}。${d.summary.join(' ')} 判定: ${d.verdict}（${d.verdictReason}）`
          : item.excerpt || '';
        out.push({
          source: 'youtube',
          url: item.url,
          title: `${t.name}: ${item.title}`,
          author: t.name,
          content: `YouTube登録チャンネル「${t.name}」の新着動画「${item.title}」${d?.durationSec ? `（${formatDurationSec(d.durationSec)}）` : ''}。${digestText}`,
          outboundUrls: [item.url],
          publishedAt: item.publishedAt,
          engagementScore: d?.verdict === 'watch' ? 3 : 2,
        });
      } else {
        out.push({
          source: 'x',
          url: item.url,
          title: `${t.name} (@${t.handle}): ${item.title.slice(0, 60)}`,
          author: t.name,
          authorHandle: t.handle ? `@${t.handle}` : undefined,
          content: item.excerpt || item.title,
          outboundUrls: [],
          publishedAt: item.publishedAt,
          engagementScore: 2,
        });
      }
    }
  }

  if (enabled.length > 0) {
    const activeLines = active.map(
      (t) => `・${t.name}（${t.platform === 'youtube' ? 'YouTube' : 'X'}）: 新着${t.newCount}件 — ${t.latestItems[0]?.title || ''}`
    );
    const quietLines = quiet
      .slice(0, 30)
      .map((t) => `${t.name}（最終: ${formatRelativeJa(t.lastActivityAt, now)}）`);
    out.push({
      source: 'generic',
      url: `https://agentcast.local/radar/${new Date(now).toISOString().slice(0, 13)}`,
      title: '登録チャンネル・フォロー動向サマリー',
      author: 'agentCast レーダー',
      content: [
        `チェック対象 ${enabled.length} 件のうち、動きあり ${active.length} 件 / 動きなし ${quiet.length} 件。`,
        activeLines.length ? `【動きあり】\n${activeLines.join('\n')}` : '【動きあり】なし',
        quietLines.length ? `【動きなし】${quietLines.join('、')}` : '',
        '番組では「誰に動きがあったか・なかったか」を冒頭で簡潔に伝え、見るべき動画には理由を添えてください。',
      ]
        .filter(Boolean)
        .join('\n'),
      outboundUrls: [],
      publishedAt: new Date(now).toISOString(),
      engagementScore: 5,
    });
  }
  return out;
}
