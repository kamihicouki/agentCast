import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { db } from '../../storage/db';
import {
  DIGEST_VERDICT_META,
  EXTRACTION_STRATEGY_META,
  PATROL_DEPTH_PRESET_META,
  PATROL_SOURCE_IDS,
  SOURCE_META,
  resolvePatrolDepth,
  type CustomSiteConfig,
  type ExtensionSettings,
  type ExtractionStrategy,
  type PatrolDepthConfig,
  type RadarItem,
  type SourceId,
  type TabGroupSummary,
  type VideoDigest,
  type WatchPlatform,
  type WatchTarget,
} from '../../shared/types';
import type { RuntimeRequest } from '../../shared/messages';
import { formatRelativeJa } from '../../shared/radar-utils';
import { extractYouTubeVideoId } from '../../extractors/youtube';
import { ensureHostPermissionsForUrls, requestPatrolPermissions, toOriginPattern } from '../../shared/permissions';
import { DATA_CONSENT_REQUIRED } from '../../shared/data-consent';
import { DigestCard } from './RadarPanel';
import { PatrolDepthControl } from './PatrolDepthControl';

interface PatrolPanelProps {
  settings: ExtensionSettings;
  isJobRunning: boolean;
  queueCount: number;
  tabGroups: TabGroupSummary[];
  selectedGroupId: number | '';
  onSelectGroupId: (id: number) => void;
  onRefreshTabGroups: () => Promise<void>;
  onClearQueue: () => Promise<void>;
  onPatchSettings: (patch: Partial<ExtensionSettings>) => Promise<void>;
  onGoToQueue: () => void;
  onPatrolAndPlay?: () => void;
  showToast: (msg: string) => void;
  setErrorBanner: (msg: string) => void;
}

type DetailTarget =
  | { kind: 'builtin'; sourceId: SourceId }
  | { kind: 'custom'; siteId: string }
  | null;

type TabCaptureScope = 'active' | 'all' | 'group';

const SOURCE_ICONS: Record<SourceId, string> = {
  youtube: '📺',
  x: '𝕏',
  note: '📝',
  zenn: '📘',
  yahoo_news: '📰',
  google_news: '🌐',
  generic: '🔗',
};

const EMPTY_SITE_DRAFT: Omit<CustomSiteConfig, 'id'> = {
  name: '',
  url: '',
  enabled: true,
  passiveEnabled: false,
  extractionStrategy: 'auto',
  cssSelector: '',
  scrollSteps: 0,
  notes: '',
};

const COLLECTION_SOURCE_PRESETS: Array<{
  label: string;
  name: string;
  url: string;
  scrollSteps: number;
}> = [
  { label: '𝕏 ブックマーク', name: 'X ブックマーク', url: 'https://x.com/i/bookmarks', scrollSteps: 2 },
  { label: '📺 YouTube 後で見る', name: 'YouTube 後で見る', url: 'https://www.youtube.com/playlist?list=WL', scrollSteps: 1 },
  { label: '👍 YouTube 高く評価', name: 'YouTube 高く評価', url: 'https://www.youtube.com/playlist?list=LL', scrollSteps: 1 },
  { label: '📝 Note スキした記事', name: 'Note スキした記事', url: 'https://note.com/likes', scrollSteps: 1 },
  { label: '📘 Zenn ブックマーク', name: 'Zenn ブックマーク', url: 'https://zenn.dev/dashboard/bookmarks', scrollSteps: 1 },
  { label: '🌐 Google News 保存済み', name: 'Google News 保存済み', url: 'https://news.google.com/my/library', scrollSteps: 1 },
];

export function PatrolPanel({
  settings,
  isJobRunning,
  queueCount,
  tabGroups,
  selectedGroupId,
  onSelectGroupId,
  onRefreshTabGroups,
  onClearQueue,
  onPatchSettings,
  onGoToQueue,
  onPatrolAndPlay,
  showToast,
  setErrorBanner,
}: PatrolPanelProps) {
  const [detail, setDetail] = useState<DetailTarget>(null);
  const [targets, setTargets] = useState<WatchTarget[]>([]);
  const [digests, setDigests] = useState<Map<string, VideoDigest>>(new Map());
  const [digestProgress, setDigestProgress] = useState<Record<string, string>>({});
  const [expandedDigest, setExpandedDigest] = useState<Record<string, boolean>>({});
  const [focusVideoId, setFocusVideoId] = useState<string | null>(null);
  const [lastRadarAt, setLastRadarAt] = useState<string | undefined>();

  // Tab capture scope & readable tab count in current window
  const [tabScope, setTabScope] = useState<TabCaptureScope>('active');
  const [allTabsCount, setAllTabsCount] = useState<number>(0);
  const [confirmClearQueue, setConfirmClearQueue] = useState(false);

  // Add source drawer state
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [siteDraft, setSiteDraft] = useState<Omit<CustomSiteConfig, 'id'>>(EMPTY_SITE_DRAFT);
  const [editingCustom, setEditingCustom] = useState<CustomSiteConfig | null>(null);

  // Follow add input inside YouTube / X detail
  const [followInput, setFollowInput] = useState('');
  const [radarFilter, setRadarFilter] = useState<'all' | 'active' | 'quiet'>('all');

  const refreshAllTabsCount = useCallback(async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const count = tabs.filter((t) => Boolean(t.id && t.url && toOriginPattern(t.url))).length;
      setAllTabsCount(count);
    } catch {
      setAllTabsCount(0);
    }
  }, []);

  useEffect(() => {
    void refreshAllTabsCount();
    const onTabChanged = () => {
      void refreshAllTabsCount();
    };
    chrome.tabs.onCreated?.addListener(onTabChanged);
    chrome.tabs.onRemoved?.addListener(onTabChanged);
    chrome.tabs.onUpdated?.addListener(onTabChanged);
    return () => {
      chrome.tabs.onCreated?.removeListener(onTabChanged);
      chrome.tabs.onRemoved?.removeListener(onTabChanged);
      chrome.tabs.onUpdated?.removeListener(onTabChanged);
    };
  }, [refreshAllTabsCount]);

  useEffect(() => {
    if (tabGroups.length === 0 && tabScope === 'group') {
      setTabScope('active');
    }
  }, [tabGroups.length, tabScope]);

  useEffect(() => {
    if (queueCount === 0) {
      setConfirmClearQueue(false);
    }
  }, [queueCount]);

  const reloadRadar = useCallback(async () => {
    const [ts, ds, stored] = await Promise.all([
      db.watchTargets.toArray(),
      db.videoDigests.toArray(),
      chrome.storage.local.get('agentcast_radar_last_run'),
    ]);
    setTargets(ts);
    setDigests(new Map(ds.map((d) => [d.videoId, d])));
    setLastRadarAt(stored.agentcast_radar_last_run as string | undefined);
  }, []);

  useEffect(() => {
    void reloadRadar();
    chrome.runtime
      .sendMessage({ type: 'GET_DIGEST_PROGRESS' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.progress) setDigestProgress(res.progress);
      })
      .catch(() => {});

    const onMsg = (msg: Record<string, unknown>) => {
      if (msg?.type === 'RADAR_UPDATED' || msg?.type === 'JOB_FINISHED') {
        void reloadRadar();
      } else if (msg?.type === 'RADAR_IMPORT_DONE' && typeof msg.message === 'string') {
        showToast(msg.message);
        void reloadRadar();
      } else if (msg?.type === 'RADAR_CHECK_DONE') {
        showToast(
          `動向チェック完了: 🟢動きあり ${msg.active} ／ ⚪動きなし ${msg.quiet}`
        );
      } else if (msg?.type === 'VIDEO_DIGEST_PROGRESS' && typeof msg.videoId === 'string') {
        setDigestProgress((p) => ({ ...p, [msg.videoId as string]: String(msg.message || '') }));
      } else if (msg?.type === 'VIDEO_DIGEST_UPDATED' && typeof msg.videoId === 'string') {
        const vid = msg.videoId;
        setDigestProgress((p) => {
          const next = { ...p };
          delete next[vid];
          return next;
        });
        if (typeof msg.error === 'string') {
          setErrorBanner(`動画要約エラー: ${msg.error}`);
        } else {
          setExpandedDigest((e) => ({ ...e, [vid]: true }));
          void db.videoDigests.get(vid).then((d) => {
            if (d) setDigests((prev) => new Map(prev).set(vid, d));
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, [reloadRadar, showToast, setErrorBanner]);

  const send = async (msg: RuntimeRequest, okToast?: string) => {
    setErrorBanner('');
    try {
      if (!(await requestPatrolPermissions(msg, settings))) {
        throw new Error('対象サイトへのアクセスが許可されませんでした。ストア版は HTTPS のみに対応します。');
      }
      const res = await chrome.runtime.sendMessage(msg);
      if (!res?.ok) setErrorBanner(res?.error || '操作に失敗しました');
      else if (okToast) showToast(okToast);
      return res;
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const removedSet = useMemo(
    () => new Set(settings.removedBuiltinSources || []),
    [settings.removedBuiltinSources]
  );

  const visibleBuiltins = useMemo(
    () => PATROL_SOURCE_IDS.filter((id) => !removedSet.has(id)),
    [removedSet]
  );

  const removedBuiltins = useMemo(
    () => PATROL_SOURCE_IDS.filter((id) => removedSet.has(id)),
    [removedSet]
  );

  const ytTargets = useMemo(() => targets.filter((t) => t.platform === 'youtube'), [targets]);
  const xTargets = useMemo(() => targets.filter((t) => t.platform === 'x'), [targets]);
  const ytActiveCount = ytTargets.filter((t) => t.enabled && t.status === 'active').length;
  const xActiveCount = xTargets.filter((t) => t.enabled && t.status === 'active').length;
  const totalActiveRadar = ytActiveCount + xActiveCount;

  const totalSourceCount = visibleBuiltins.length + (settings.customSites || []).length;
  const enabledSourceCount =
    visibleBuiltins.filter((id) => settings.enabledSources[id]).length +
    (settings.customSites || []).filter((s) => s.enabled).length;

  const handleToggleBuiltin = async (srcId: SourceId, enabled: boolean) => {
    await onPatchSettings({
      enabledSources: { ...settings.enabledSources, [srcId]: enabled },
    });
  };

  const handleRemoveBuiltin = async (srcId: SourceId) => {
    const nextRemoved = Array.from(new Set([...(settings.removedBuiltinSources || []), srcId]));
    await onPatchSettings({
      removedBuiltinSources: nextRemoved,
      enabledSources: { ...settings.enabledSources, [srcId]: false },
    });
    showToast(`「${SOURCE_META[srcId].shortLabel}」を巡回一覧から削除しました`);
  };

  const handleRestoreBuiltin = async (srcId: SourceId) => {
    const nextRemoved = (settings.removedBuiltinSources || []).filter((id) => id !== srcId);
    await onPatchSettings({
      removedBuiltinSources: nextRemoved,
      enabledSources: { ...settings.enabledSources, [srcId]: true },
    });
    showToast(`「${SOURCE_META[srcId].shortLabel}」を巡回一覧に追加しました`);
  };

  const handleToggleCustom = async (siteId: string, enabled: boolean) => {
    const next = (settings.customSites || []).map((s) =>
      s.id === siteId ? { ...s, enabled } : s
    );
    await onPatchSettings({ customSites: next });
  };

  const handleDeleteCustom = async (siteId: string) => {
    const target = (settings.customSites || []).find((s) => s.id === siteId);
    const next = (settings.customSites || []).filter((s) => s.id !== siteId);
    await onPatchSettings({ customSites: next });
    if (detail?.kind === 'custom' && detail.siteId === siteId) setDetail(null);
    if (target) showToast(`「${target.name}」を削除しました`);
  };

  const handlePrefillActiveTab = async () => {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.url || !toOriginPattern(active.url)) {
        setErrorBanner('現在のタブは追加できないページです。');
        return;
      }
      const isChangelog = /changelog|release/i.test(active.url);
      setSiteDraft({
        ...EMPTY_SITE_DRAFT,
        name: (active.title || new URL(active.url).hostname).slice(0, 40),
        url: active.url,
        extractionStrategy: isChangelog ? 'changelog' : 'auto',
      });
      setIsAddOpen(true);
    } catch {
      setErrorBanner('現在のタブ情報を取得できませんでした。');
    }
  };

  const handleAddCustomSite = async () => {
    const url = siteDraft.url.trim();
    if (!toOriginPattern(url)) {
      setErrorBanner(DATA_CONSENT_REQUIRED ? 'HTTPS の URL を入力してください。' : 'HTTP または HTTPS の URL を入力してください。');
      return;
    }
    if (siteDraft.passiveEnabled && !(await ensureHostPermissionsForUrls([url]))) {
      setErrorBanner('受動収集の対象サイトへのアクセスが許可されませんでした。');
      return;
    }
    const name = siteDraft.name.trim() || new URL(url).hostname;
    const newSite: CustomSiteConfig = {
      id: `site-${Date.now()}`,
      ...siteDraft,
      name,
      url,
      cssSelector: siteDraft.cssSelector?.trim() || undefined,
      notes: siteDraft.notes?.trim() || undefined,
    };
    await onPatchSettings({ customSites: [...(settings.customSites || []), newSite] });
    setSiteDraft(EMPTY_SITE_DRAFT);
    setIsAddOpen(false);
    showToast(`「${name}」を巡回ソースに追加しました`);
  };

  const handleSaveCustomEdit = async () => {
    if (!editingCustom) return;
    if (!toOriginPattern(editingCustom.url)) {
      setErrorBanner(DATA_CONSENT_REQUIRED ? 'HTTPS の URL を入力してください。' : 'HTTP または HTTPS の URL を入力してください。');
      return;
    }
    if (editingCustom.passiveEnabled && !(await ensureHostPermissionsForUrls([editingCustom.url]))) {
      setErrorBanner('受動収集の対象サイトへのアクセスが許可されませんでした。');
      return;
    }
    const next = (settings.customSites || []).map((s) =>
      s.id === editingCustom.id ? editingCustom : s
    );
    await onPatchSettings({ customSites: next });
    showToast(`「${editingCustom.name}」の設定を保存しました`);
    setDetail(null);
    setEditingCustom(null);
  };

  const handleSummarize = (url: string, force = false) => {
    const vid = extractYouTubeVideoId(url);
    if (!vid) return;
    if (!force && digests.has(vid)) {
      setExpandedDigest((e) => ({ ...e, [vid]: !e[vid] }));
      return;
    }
    setDigestProgress((p) => ({ ...p, [vid]: '開始中...' }));
    void send({ type: 'SUMMARIZE_YOUTUBE_VIDEO', videoUrl: url, force });
  };

  const handleSummarizeActiveVideo = async () => {
    const res = await send({ type: 'SUMMARIZE_ACTIVE_YOUTUBE_TAB' });
    if (res?.ok && typeof res.videoId === 'string') {
      setFocusVideoId(res.videoId);
      setDigestProgress((p) => ({ ...p, [res.videoId]: '開始中...' }));
    }
  };

  const handleAddWatchTarget = async (platform: WatchPlatform) => {
    if (!followInput.trim()) return;
    const res = await send(
      { type: 'RADAR_ADD_TARGET', platform, input: followInput.trim() },
      '監視対象に追加しました'
    );
    if (res?.ok) {
      setFollowInput('');
      void reloadRadar();
    }
  };

  const renderRadarItem = (t: WatchTarget, item: RadarItem, isNew: boolean) => {
    const vid = t.platform === 'youtube' ? extractYouTubeVideoId(item.url) : null;
    const digest = vid ? digests.get(vid) : undefined;
    const progress = vid ? digestProgress[vid] : undefined;
    return (
      <li key={item.id} className={`radar-item ${isNew ? 'is-new' : ''}`}>
        <div className="radar-item-line">
          {isNew && <span className="new-dot" aria-label="新着" />}
          <a href={item.url} target="_blank" rel="noreferrer" className="radar-item-title">
            {item.title || item.excerpt || '(無題)'}
          </a>
          <span className="radar-item-time">{formatRelativeJa(item.publishedAt)}</span>
        </div>
        {vid && (
          <div className="radar-item-actions">
            {digest && (
              <span className={`verdict-badge verdict-${digest.verdict} is-compact`}>
                {DIGEST_VERDICT_META[digest.verdict].emoji} {DIGEST_VERDICT_META[digest.verdict].label}
              </span>
            )}
            <button
              type="button"
              className="btn-ghost btn-digest"
              disabled={Boolean(progress)}
              onClick={() => handleSummarize(item.url)}
            >
              {progress
                ? `⏳ ${progress}`
                : digest
                  ? expandedDigest[vid]
                    ? '要約を閉じる'
                    : '要約を見る'
                  : '🧠 要約して判断'}
            </button>
          </div>
        )}
        {vid && digest && expandedDigest[vid] && (
          <DigestCard digest={digest} onRerun={() => handleSummarize(item.url, true)} />
        )}
      </li>
    );
  };

  // ==================== DRILL-DOWN DETAIL VIEW ====================
  if (detail) {
    if (detail.kind === 'custom') {
      const current =
        editingCustom || (settings.customSites || []).find((s) => s.id === detail.siteId);
      if (!current) {
        setDetail(null);
        return null;
      }
      return (
        <section className="step-section" aria-label="カスタムソース詳細">
          <div className="detail-nav">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setDetail(null);
                setEditingCustom(null);
              }}
            >
              ← ソース一覧に戻る
            </button>
            <span className="pill-badge">🔗 カスタム設定</span>
          </div>

          <div className="n-primary-card">
            <div className="card-head-row">
              <strong>{current.name}</strong>
              <span className="method-badge">
                {EXTRACTION_STRATEGY_META[current.extractionStrategy].label}
              </span>
            </div>
            <div className="action-row-2">
              <button
                type="button"
                className="btn-primary"
                disabled={isJobRunning}
                onClick={() =>
                  void send(
                    { type: 'PATROL_CUSTOM_SITE', siteId: current.id, generateAfter: false },
                    `${current.name} の巡回を開始しました`
                  )
                }
              >
                ▶ このソースを今すぐ巡回
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={isJobRunning}
                onClick={() =>
                  void send(
                    { type: 'PATROL_CUSTOM_SITE', siteId: current.id, generateAfter: true },
                    `${current.name} を即番組化します`
                  )
                }
              >
                🎙 これだけで番組化
              </button>
            </div>
          </div>

          <PatrolDepthControl
            sourceId="generic"
            value={resolvePatrolDepth('generic', current.patrolDepth, current.scrollSteps)}
            onChange={(nextDepth: PatrolDepthConfig) =>
              setEditingCustom({
                ...current,
                patrolDepth: nextDepth,
                scrollSteps: nextDepth.scrollSteps,
              })
            }
          />

          <div className="n-card">
            <div className="field-row">
              <label className="field-label">表示名</label>
              <input
                className="field-input"
                value={current.name}
                onChange={(e) => setEditingCustom({ ...current, name: e.target.value })}
              />
            </div>
            <div className="field-row">
              <label className="field-label">対象URL</label>
              <input
                className="field-input"
                value={current.url}
                onChange={(e) => setEditingCustom({ ...current, url: e.target.value })}
              />
            </div>
            <div className="field-row">
              <label className="field-label">情報抽出の方式</label>
              <select
                className="field-select"
                value={current.extractionStrategy}
                onChange={(e) =>
                  setEditingCustom({
                    ...current,
                    extractionStrategy: e.target.value as ExtractionStrategy,
                  })
                }
              >
                {(Object.keys(EXTRACTION_STRATEGY_META) as ExtractionStrategy[]).map((k) => (
                  <option key={k} value={k}>
                    {EXTRACTION_STRATEGY_META[k].label}
                  </option>
                ))}
              </select>
            </div>
            {current.extractionStrategy === 'css_selector' && (
              <div className="field-row">
                <label className="field-label">CSS セレクタ</label>
                <input
                  className="field-input"
                  value={current.cssSelector || ''}
                  placeholder="article, .post-card"
                  onChange={(e) => setEditingCustom({ ...current, cssSelector: e.target.value })}
                />
              </div>
            )}
            <div className="toggle-row">
              <span>普段の閲覧時に自動で受動ストック</span>
              <input
                type="checkbox"
                checked={current.passiveEnabled}
                onChange={(e) => setEditingCustom({ ...current, passiveEnabled: e.target.checked })}
              />
            </div>
            <div className="action-row-2" style={{ marginTop: 10 }}>
              <button type="button" className="btn-primary" onClick={() => void handleSaveCustomEdit()}>
                変更を保存
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void handleDeleteCustom(current.id)}
              >
                このソースを削除
              </button>
            </div>
          </div>
        </section>
      );
    }

    // Built-in detail (YouTube / X / others)
    const srcId = detail.sourceId;
    const meta = SOURCE_META[srcId];
    const isRadarPlatform = srcId === 'youtube' || srcId === 'x';
    const platform: WatchPlatform | null = isRadarPlatform ? srcId : null;
    const platformTargets = platform === 'youtube' ? ytTargets : platform === 'x' ? xTargets : [];
    const filteredPlatformTargets = platformTargets
      .filter((t) => {
        if (radarFilter === 'active') return t.enabled && t.status === 'active';
        if (radarFilter === 'quiet') return t.enabled && t.status === 'quiet';
        return true;
      })
      .sort((a, b) => {
        const score = (x: WatchTarget) => (!x.enabled ? 9 : x.status === 'active' ? 0 : x.status === 'error' ? 1 : 2);
        return score(a) - score(b);
      });
    const focusDigest = focusVideoId ? digests.get(focusVideoId) : undefined;

    return (
      <section className="step-section" aria-label={`${meta.shortLabel} 詳細設定`}>
        <div className="detail-nav">
          <button type="button" className="btn-secondary" onClick={() => setDetail(null)}>
            ← ソース一覧に戻る
          </button>
          <span className="pill-badge">
            {SOURCE_ICONS[srcId]} {meta.shortLabel} 詳細
          </span>
        </div>

        <div className="n-primary-card">
          <div className="card-head-row">
            <strong>{meta.label}</strong>
            <span className="method-badge">{meta.extractionMethod}</span>
          </div>
          <p className="field-hint">{meta.description}</p>

          {platform === 'youtube' && (
            <>
              <div className="toggle-row">
                <span>巡回時に動きありチャンネル動向も含める</span>
                <input
                  type="checkbox"
                  checked={settings.radarIncludeInPatrol}
                  onChange={(e) =>
                    void onPatchSettings({ radarIncludeInPatrol: e.target.checked })
                  }
                />
              </div>
              <div className="action-row-2" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={isJobRunning || ytTargets.length === 0}
                  onClick={() => void send({ type: 'RADAR_CHECK', platforms: ['youtube'] })}
                >
                  動向をチェック
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={isJobRunning}
                  onClick={() => void send({ type: 'RADAR_IMPORT_YOUTUBE_SUBS' })}
                >
                  📺 登録chを取り込む
                </button>
              </div>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginTop: 6 }}
                onClick={() => void handleSummarizeActiveVideo()}
              >
                ▶ 今開いている YouTube 動画を要約して判断
              </button>
              {focusVideoId && digestProgress[focusVideoId] && (
                <p className="radar-progress">⏳ {digestProgress[focusVideoId]}</p>
              )}
              {focusDigest && !digestProgress[focusVideoId!] && (
                <div className="focus-digest">
                  <p className="focus-digest-title">
                    <a href={focusDigest.url} target="_blank" rel="noreferrer">
                      {focusDigest.title}
                    </a>
                  </p>
                  <DigestCard
                    digest={focusDigest}
                    onRerun={() => handleSummarize(focusDigest.url, true)}
                  />
                </div>
              )}
            </>
          )}

          {platform === 'x' && (
            <>
              <div className="toggle-row">
                <span>巡回時に個別フォロー動向チェックも含める</span>
                <input
                  type="checkbox"
                  checked={settings.radarIncludeInPatrol}
                  onChange={(e) =>
                    void onPatchSettings({ radarIncludeInPatrol: e.target.checked })
                  }
                />
              </div>
              <div className="action-row-2" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={isJobRunning || xTargets.filter((t) => t.enabled).length === 0}
                  onClick={() => void send({ type: 'RADAR_CHECK', platforms: ['x'] })}
                >
                  フォロー動向をチェック
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={isJobRunning}
                  onClick={() => void send({ type: 'RADAR_IMPORT_X_FOLLOWING' })}
                >
                  𝕏 フォローを取り込む
                </button>
              </div>
            </>
          )}

          {!platform && (
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: 8 }}
              disabled={isJobRunning}
              onClick={() =>
                void send(
                  { type: 'PATROL_SOURCES', sources: [srcId] },
                  `${meta.shortLabel} を巡回しています…`
                )
              }
            >
              ▶ {meta.shortLabel} を今すぐ単体巡回
            </button>
          )}
        </div>

        {/* Per-site Patrol Depth Control */}
        <PatrolDepthControl
          sourceId={srcId}
          value={resolvePatrolDepth(srcId, settings.sourcePatrolDepth?.[srcId])}
          onChange={(nextDepth: PatrolDepthConfig) =>
            void onPatchSettings({
              sourcePatrolDepth: {
                ...(settings.sourcePatrolDepth ?? {}),
                [srcId]: nextDepth,
              },
            })
          }
        />

        {/* Radar Targets List inside YouTube / X detail */}
        {platform && (
          <div className="n-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="card-head-row">
              <strong>
                監視リスト（{platformTargets.filter((t) => t.enabled).length}/{platformTargets.length} ON）
              </strong>
              <span className="field-hint" style={{ margin: 0 }}>
                {lastRadarAt ? `確認 ${formatRelativeJa(lastRadarAt)}` : '未チェック'}
              </span>
            </div>

            <div className="inline-add-row">
              <input
                className="field-input"
                value={followInput}
                placeholder={
                  platform === 'youtube'
                    ? 'https://www.youtube.com/@handle'
                    : '@handle または https://x.com/handle'
                }
                onChange={(e) => setFollowInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddWatchTarget(platform);
                }}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={!followInput.trim()}
                onClick={() => void handleAddWatchTarget(platform)}
              >
                追加
              </button>
            </div>

            <div className="segmented segmented-3">
              {(['all', 'active', 'quiet'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`segment ${radarFilter === f ? 'is-active' : ''}`}
                  onClick={() => setRadarFilter(f)}
                >
                  {f === 'all'
                    ? `すべて (${platformTargets.length})`
                    : f === 'active'
                      ? `🟢 動きあり (${platform === 'youtube' ? ytActiveCount : xActiveCount})`
                      : `⚪ 動きなし`}
                </button>
              ))}
            </div>

            {filteredPlatformTargets.length === 0 ? (
              <p className="field-hint">該当する監視対象がありません。</p>
            ) : (
              <ul className="radar-list">
                {filteredPlatformTargets.slice(0, 40).map((t) => {
                  const newIds = new Set(
                    t.status === 'active' ? t.latestItems.slice(0, t.newCount).map((i) => i.id) : []
                  );
                  return (
                    <li key={t.id} className={`radar-target status-${t.enabled ? t.status : 'off'}`}>
                      <div className="radar-target-head">
                        <span className={`status-dot status-${t.enabled ? t.status : 'off'}`} />
                        <a href={t.url} target="_blank" rel="noreferrer" className="radar-target-name">
                          {t.name}
                        </a>
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          onChange={(e) => {
                            void db.watchTargets.update(t.id, { enabled: e.target.checked });
                            setTargets((prev) =>
                              prev.map((p) => (p.id === t.id ? { ...p, enabled: e.target.checked } : p))
                            );
                          }}
                        />
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            void db.watchTargets.delete(t.id);
                            setTargets((prev) => prev.filter((p) => p.id !== t.id));
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      <p className="radar-target-status">
                        {!t.enabled
                          ? '監視OFF'
                          : t.status === 'active'
                            ? `🟢 新着 ${t.newCount} 件（${formatRelativeJa(t.lastActivityAt)}）`
                            : t.status === 'quiet'
                              ? `⚪ 動きなし（最終: ${formatRelativeJa(t.lastActivityAt)}）`
                              : t.status === 'error'
                                ? `⚠ ${t.statusMessage || '確認失敗'}`
                                : '未チェック'}
                      </p>
                      {t.enabled && t.latestItems.length > 0 && (
                        <ul className="radar-items">
                          {t.latestItems
                            .slice(0, t.status === 'active' ? Math.max(1, Math.min(t.newCount, 4)) : 1)
                            .map((item) => renderRadarItem(t, item, newIds.has(item.id)))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <button
              type="button"
              className="btn-secondary"
              disabled={isJobRunning || platformTargets.length === 0}
              onClick={() =>
                void send({ type: 'RADAR_GENERATE_EPISODE', checkFirst: !lastRadarAt })
              }
            >
              🎙 動向サマリー＋新着を番組化
            </button>
          </div>
        )}

        <div className="n-card">
          <div className="field-label">抽出の仕組み</div>
          <p className="field-hint">
            <strong>巡回URL:</strong> {meta.startUrl}
            <br />
            {meta.extractionDetail}
          </p>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void handleRemoveBuiltin(srcId);
              setDetail(null);
            }}
          >
            このソースを巡回一覧から削除
          </button>
        </div>
      </section>
    );
  }

  // ==================== MAIN FLAT SOURCE LIST VIEW ====================
  const selectedGroup = tabGroups.find((g) => g.id === selectedGroupId) || tabGroups[0];
  const isTabActionDisabled =
    isJobRunning ||
    (tabScope === 'all' && allTabsCount === 0) ||
    (tabScope === 'group' && selectedGroupId === '');

  const handleTabCapture = async (generateAfter: boolean) => {
    setErrorBanner('');
    if (tabScope === 'active') {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.url && !(await ensureHostPermissionsForUrls([active.url]))) {
        setErrorBanner('このページを読み取る権限が許可されませんでした。');
        return;
      }
      if (generateAfter) {
        void send(
          { type: 'CAPTURE_AND_GENERATE_ACTIVE_TAB' },
          '今のタブだけで番組を作成します'
        );
      } else {
        const res = await send({ type: 'CAPTURE_ACTIVE_TAB' });
        if (res?.ok) {
          showToast(`今のタブから ${res.inserted} 件をキューに追加しました`);
          onGoToQueue();
        }
      }
      return;
    }

    if (tabScope === 'all') {
      const windowTabs = await chrome.tabs.query({ currentWindow: true });
      const urls = windowTabs
        .map((t) => t.url)
        .filter((u): u is string => Boolean(u && toOriginPattern(u)));
      if (urls.length === 0) {
        setErrorBanner('現在のウィンドウに読み取り可能なWebページがありません。');
        return;
      }
      if (!(await ensureHostPermissionsForUrls(urls))) {
        setErrorBanner('開いているタブを読み取る権限が許可されませんでした。');
        return;
      }
      void send(
        { type: 'PATROL_ALL_TABS', generateAfter },
        generateAfter
          ? `開いている全 ${urls.length} タブから番組を作成します`
          : `開いている全 ${urls.length} タブの取り込みを開始しました`
      );
      return;
    }

    if (selectedGroupId === '') return;
    const groupTabs = await chrome.tabs.query({ groupId: selectedGroupId });
    const urls = groupTabs
      .map((t) => t.url)
      .filter((u): u is string => Boolean(u && toOriginPattern(u)));
    if (!(await ensureHostPermissionsForUrls(urls))) {
      setErrorBanner('タブグループ内のページを読み取る権限が許可されませんでした。');
      return;
    }
    void send(
      { type: 'PATROL_TAB_GROUP', groupId: selectedGroupId, generateAfter },
      generateAfter
        ? '選択したタブグループから番組を作成します'
        : 'タブグループの巡回を開始しました'
    );
  };

  const tabQueueLabel =
    tabScope === 'active'
      ? '今のタブをキューへ'
      : tabScope === 'all'
        ? `全${allTabsCount}タブをキューへ`
        : `${selectedGroup ? `${selectedGroup.tabCount}タブ` : 'グループ'}をキューへ`;

  const tabInstantLabel =
    tabScope === 'active'
      ? '今のタブで即番組化'
      : tabScope === 'all'
        ? `全${allTabsCount}タブで即番組化`
        : `${selectedGroup ? `${selectedGroup.tabCount}タブ` : 'グループ'}で即番組化`;

  const tabScopeMeta =
    tabScope === 'active'
      ? '現在の1タブ'
      : tabScope === 'all'
        ? `全 ${allTabsCount} タブ`
        : selectedGroup
          ? `${selectedGroup.tabCount} タブ`
          : 'タブグループ';

  return (
    <section className="step-section" aria-label="巡回ソース管理">
      {/* Primary Patrol Actions */}
      <div className="n-primary-card">
        <div className="card-head-row">
          <strong>有効なソースを巡回</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {totalActiveRadar > 0 && (
              <span className="pill-badge is-sage">動きあり {totalActiveRadar}</span>
            )}
            <span className={`mono-pill ${enabledSourceCount === 0 ? 'is-warn' : ''}`}>
              {enabledSourceCount}/{totalSourceCount} ON
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          {onPatrolAndPlay && (
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={isJobRunning || enabledSourceCount === 0}
              onClick={onPatrolAndPlay}
            >
              {enabledSourceCount === 0
                ? '巡回ソースを1つ以上ONにしてください'
                : `選択中の ${enabledSourceCount} ソースを巡回して再生`}
            </button>
          )}
          <button
            id="btn-patrol-to-queue"
            type="button"
            className="btn-secondary"
            style={{ width: '100%' }}
            disabled={isJobRunning || enabledSourceCount === 0}
            onClick={() => {
              void send({ type: 'PATROL_SOURCES' }, '巡回を開始しました。素材はキューに入ります');
            }}
          >
            キューに収集するだけ（素材を選んでから作成）
          </button>
        </div>
      </div>

      {/* Collapsible Browser Tab Capture */}
      <details className="tab-capture-details">
        <summary>
          <span>開いているタブから取り込む</span>
          <span className="mono-pill">{tabScopeMeta}</span>
        </summary>

        <div
          className={`tab-scope-seg ${tabGroups.length === 0 ? 'is-2col' : ''}`}
          role="tablist"
          aria-label="取り込むタブの範囲"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tabScope === 'active'}
            className={`tab-scope-btn ${tabScope === 'active' ? 'is-active' : ''}`}
            onClick={() => setTabScope('active')}
          >
            今のタブ
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tabScope === 'all'}
            className={`tab-scope-btn ${tabScope === 'all' ? 'is-active' : ''}`}
            onClick={() => {
              setTabScope('all');
              void refreshAllTabsCount();
            }}
          >
            全タブ ({allTabsCount})
          </button>
          {tabGroups.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={tabScope === 'group'}
              className={`tab-scope-btn ${tabScope === 'group' ? 'is-active' : ''}`}
              onClick={() => setTabScope('group')}
            >
              グループ
            </button>
          )}
        </div>

        {tabScope === 'group' && tabGroups.length > 0 && (
          <div className="tabgroup-inline">
            <select
              className="field-select"
              value={selectedGroupId}
              onChange={(e) => onSelectGroupId(Number(e.target.value))}
              aria-label="取り込むタブグループ"
            >
              {tabGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} ({g.tabCount}タブ)
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void onRefreshTabGroups()}
              title="タブグループ一覧を更新"
            >
              ↻
            </button>
          </div>
        )}

        <div className="action-row-2" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn-secondary btn-compact"
            disabled={isTabActionDisabled}
            onClick={() => void handleTabCapture(false)}
          >
            {tabQueueLabel}
          </button>
          <button
            type="button"
            className="btn-primary btn-compact"
            disabled={isTabActionDisabled}
            onClick={() => void handleTabCapture(true)}
          >
            {tabInstantLabel}
          </button>
        </div>
      </details>

      {/* Queue Status Strip (only when queue has items) */}
      {queueCount > 0 && (
        <div className="n-card flow-bar">
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: 0, color: 'var(--text-primary)' }}
            onClick={onGoToQueue}
          >
            未読キュー: <strong className="mono-inline">{queueCount}件</strong> を確認 →
          </button>
          {confirmClearQueue ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="btn-danger-solid btn-compact"
                disabled={isJobRunning}
                onClick={() => {
                  setConfirmClearQueue(false);
                  void onClearQueue();
                }}
              >
                空にする
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setConfirmClearQueue(false)}
              >
                戻る
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              disabled={isJobRunning}
              onClick={() => setConfirmClearQueue(true)}
            >
              クリア
            </button>
          )}
        </div>
      )}

      {/* Flat Unified Source List */}
      <div className="list-head-row">
        <span className="section-label">巡回ソース</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn-ghost" onClick={() => void handlePrefillActiveTab()}>
            ＋ 今のタブを登録
          </button>
          <button
            type="button"
            className="btn-ghost is-accent"
            onClick={() => setIsAddOpen((v) => !v)}
          >
            {isAddOpen ? '閉じる' : '＋ 追加'}
          </button>
        </div>
      </div>

      {isAddOpen && (
        <div className="n-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="quick-collection-box" style={{ borderTop: 'none', paddingTop: 0 }}>
            <div className="field-label">ブックマーク・お気に入り・リストを1クリック追加</div>
            <div className="quick-collection-chips">
              {COLLECTION_SOURCE_PRESETS.map((preset) => {
                const alreadyAdded = (settings.customSites || []).some((s) => s.url === preset.url);
                return (
                  <button
                    key={preset.url}
                    type="button"
                    className="btn-secondary btn-compact"
                    disabled={alreadyAdded}
                    onClick={() => {
                      void (async () => {
                        const newSite: CustomSiteConfig = {
                          id: `site-${Date.now()}`,
                          name: preset.name,
                          url: preset.url,
                          enabled: true,
                          passiveEnabled: false,
                          extractionStrategy: 'auto',
                          scrollSteps: preset.scrollSteps,
                        };
                        await onPatchSettings({
                          customSites: [...(settings.customSites || []), newSite],
                        });
                        showToast(`「${preset.name}」を巡回ソースに追加しました`);
                      })();
                    }}
                  >
                    {alreadyAdded ? `✓ ${preset.label}` : `＋ ${preset.label}`}
                  </button>
                );
              })}
            </div>
            <p className="field-hint" style={{ margin: 0 }}>
              <strong>X.com リスト</strong>（<code>x.com/i/lists/...</code>）や YouTube プレイリストは、対象ページを開いて「＋ 今のタブを登録」を押すか下にURLを貼り付けて追加できます。
            </p>
          </div>
          <div className="field-row">
            <label className="field-label">サイト名（任意）</label>
            <input
              className="field-input"
              value={siteDraft.name}
              placeholder="例: X AIリスト / Antigravity Changelog"
              onChange={(e) => setSiteDraft({ ...siteDraft, name: e.target.value })}
            />
          </div>
          <div className="field-row">
            <label className="field-label">URL / Xリスト / プレイリスト / RSS</label>
            <input
              className="field-input"
              value={siteDraft.url}
              placeholder="https://x.com/i/lists/... または https://..."
              onChange={(e) => setSiteDraft({ ...siteDraft, url: e.target.value })}
            />
          </div>
          <div className="field-row">
            <label className="field-label">抽出方式</label>
            <select
              className="field-select"
              value={siteDraft.extractionStrategy}
              onChange={(e) =>
                setSiteDraft({
                  ...siteDraft,
                  extractionStrategy: e.target.value as ExtractionStrategy,
                })
              }
            >
              {(Object.keys(EXTRACTION_STRATEGY_META) as ExtractionStrategy[]).map((k) => (
                <option key={k} value={k}>
                  {EXTRACTION_STRATEGY_META[k].label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleAddCustomSite()}
          >
            このソースを追加
          </button>

          {removedBuiltins.length > 0 && (
            <div className="preset-restore">
              <div className="field-label">削除済みプリセットを復元</div>
              <div className="preset-chips">
                {removedBuiltins.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="btn-secondary btn-compact"
                    onClick={() => void handleRestoreBuiltin(id)}
                  >
                    ＋ {SOURCE_META[id].shortLabel}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flat-source-list">
        {visibleBuiltins.map((srcId) => {
          const meta = SOURCE_META[srcId];
          const enabled = Boolean(settings.enabledSources[srcId]);
          const badge =
            srcId === 'youtube' && ytActiveCount > 0
              ? `新着 ${ytActiveCount}`
              : srcId === 'x' && xActiveCount > 0
                ? `新着 ${xActiveCount}`
                : null;
          const summary =
            srcId === 'youtube'
              ? ytTargets.length > 0
                ? `登録 ${ytTargets.length}ch · 新着 ${ytActiveCount}`
                : meta.description
              : srcId === 'x' && xTargets.length > 0
                ? `タイムライン ＋ 監視 ${xTargets.filter((t) => t.enabled).length}人`
                : meta.description;

          return (
            <div key={srcId} className={`flat-source-row ${enabled ? '' : 'is-off'}`}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => void handleToggleBuiltin(srcId, e.target.checked)}
                aria-label={`${meta.shortLabel} を巡回対象にする`}
              />
              <button
                type="button"
                className="flat-source-body"
                onClick={() => setDetail({ kind: 'builtin', sourceId: srcId })}
              >
                <div className="flat-source-top">
                  <span className="flat-source-name">{meta.shortLabel}</span>
                  {(() => {
                    const d = resolvePatrolDepth(srcId, settings.sourcePatrolDepth?.[srcId]);
                    return (
                      <span
                        className={`depth-pill is-${d.preset}`}
                        title={`スクロール${d.scrollSteps}回 / 最大${d.maxItems}件 / 本文展開${d.deepFetchLimit}件`}
                      >
                        {PATROL_DEPTH_PRESET_META[d.preset].shortLabel}
                      </span>
                    );
                  })()}
                  {badge && <span className="pill-badge is-sage">{badge}</span>}
                </div>
                <div className="flat-source-sub">{summary}</div>
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setDetail({ kind: 'builtin', sourceId: srcId })}
                aria-label={`${meta.shortLabel} の詳細`}
              >
                詳細 ›
              </button>
            </div>
          );
        })}

        {(settings.customSites || []).map((site) => (
          <div key={site.id} className={`flat-source-row ${site.enabled ? '' : 'is-off'}`}>
            <input
              type="checkbox"
              checked={site.enabled}
              onChange={(e) => void handleToggleCustom(site.id, e.target.checked)}
              aria-label={`${site.name} を巡回対象にする`}
            />
            <button
              type="button"
              className="flat-source-body"
              onClick={() => {
                setEditingCustom({ ...site });
                setDetail({ kind: 'custom', siteId: site.id });
              }}
            >
              <div className="flat-source-top">
                <span className="flat-source-name">{site.name}</span>
                {(() => {
                  const d = resolvePatrolDepth('generic', site.patrolDepth, site.scrollSteps);
                  return (
                    <span
                      className={`depth-pill is-${d.preset}`}
                      title={`スクロール${d.scrollSteps}回 / 最大${d.maxItems}件 / 本文展開${d.deepFetchLimit}件`}
                    >
                      {PATROL_DEPTH_PRESET_META[d.preset].shortLabel}
                    </span>
                  );
                })()}
                <span className="method-badge">
                  {EXTRACTION_STRATEGY_META[site.extractionStrategy].label}
                </span>
              </div>
              <div className="flat-source-sub">{site.url}</div>
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEditingCustom({ ...site });
                setDetail({ kind: 'custom', siteId: site.id });
              }}
              aria-label={`${site.name} の詳細`}
            >
              詳細 ›
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
