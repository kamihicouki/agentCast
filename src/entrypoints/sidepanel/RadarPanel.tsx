import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { db } from '../../storage/db';
import {
  DIGEST_METHOD_LABEL,
  DIGEST_VERDICT_META,
  type ExtensionSettings,
  type RadarItem,
  type VideoDigest,
  type WatchPlatform,
  type WatchTarget,
} from '../../shared/types';
import type { RuntimeRequest } from '../../shared/messages';
import { formatRelativeJa } from '../../shared/radar-utils';
import { extractYouTubeVideoId, formatDurationSec } from '../../extractors/youtube';

type RadarFilter = 'all' | 'active' | 'quiet' | 'off';
type PlatformFilter = 'all' | WatchPlatform;

interface RadarPanelProps {
  settings: ExtensionSettings;
  isJobRunning: boolean;
  onPatchSettings: (patch: Partial<ExtensionSettings>) => Promise<void>;
  showToast: (msg: string) => void;
  setErrorBanner: (msg: string) => void;
}

const PAGE_SIZE = 40;

function timeToSeconds(label: string): number | null {
  const parts = label.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function statusRank(t: WatchTarget): number {
  if (!t.enabled) return 9;
  return { active: 0, error: 1, unknown: 2, quiet: 3 }[t.status] ?? 4;
}

export function DigestCard({
  digest,
  onRerun,
}: {
  digest: VideoDigest;
  onRerun?: () => void;
}) {
  const verdict = DIGEST_VERDICT_META[digest.verdict];
  return (
    <div className={`digest-card verdict-${digest.verdict}`}>
      <div className="digest-head">
        <span className={`verdict-badge verdict-${digest.verdict}`}>
          {verdict.emoji} {verdict.label}
        </span>
        <span className="digest-relevance" title="関心との関連度">
          関連度 {digest.relevance}
          <span className="relevance-bar">
            <span style={{ width: `${digest.relevance}%` }} />
          </span>
        </span>
      </div>
      <p className="digest-oneliner">{digest.oneLiner}</p>
      {digest.verdictReason && <p className="digest-reason">{digest.verdictReason}</p>}
      {digest.summary.length > 0 && (
        <ul className="digest-summary">
          {digest.summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
      {digest.keyPoints.length > 0 && (
        <ol className="digest-keypoints">
          {digest.keyPoints.map((kp, i) => {
            const sec = timeToSeconds(kp.time);
            return (
              <li key={i}>
                {sec !== null ? (
                  <a href={`${digest.url}&t=${sec}s`} target="_blank" rel="noreferrer" className="kp-time">
                    {kp.time}
                  </a>
                ) : (
                  <span className="kp-time">{kp.time || '—'}</span>
                )}
                <span>{kp.point}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="digest-foot">
        <span>
          {DIGEST_METHOD_LABEL[digest.method]}
          {digest.durationSec ? ` ・ ${formatDurationSec(digest.durationSec)}` : ''}
        </span>
        {onRerun && (
          <button type="button" className="btn-ghost" onClick={onRerun}>
            再要約
          </button>
        )}
      </div>
    </div>
  );
}

export function RadarPanel({
  settings,
  isJobRunning,
  onPatchSettings,
  showToast,
  setErrorBanner,
}: RadarPanelProps) {
  const [targets, setTargets] = useState<WatchTarget[]>([]);
  const [digests, setDigests] = useState<Map<string, VideoDigest>>(new Map());
  const [digestProgress, setDigestProgress] = useState<Record<string, string>>({});
  const [expandedDigest, setExpandedDigest] = useState<Record<string, boolean>>({});
  const [focusVideoId, setFocusVideoId] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | undefined>();
  const [filter, setFilter] = useState<RadarFilter>('all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [addPlatform, setAddPlatform] = useState<WatchPlatform>('youtube');
  const [addInput, setAddInput] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const reload = useCallback(async () => {
    const [ts, ds, stored] = await Promise.all([
      db.watchTargets.toArray(),
      db.videoDigests.toArray(),
      chrome.storage.local.get('agentcast_radar_last_run'),
    ]);
    setTargets(ts);
    setDigests(new Map(ds.map((d) => [d.videoId, d])));
    setLastRunAt(stored.agentcast_radar_last_run as string | undefined);
  }, []);

  useEffect(() => {
    void reload();
    chrome.runtime
      .sendMessage({ type: 'GET_DIGEST_PROGRESS' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.progress) setDigestProgress(res.progress);
      })
      .catch(() => {});

    const onMsg = (msg: Record<string, unknown>) => {
      if (msg?.type === 'RADAR_UPDATED' || msg?.type === 'JOB_FINISHED') {
        void reload();
      } else if (msg?.type === 'RADAR_IMPORT_DONE' && typeof msg.message === 'string') {
        showToast(msg.message);
        void reload();
      } else if (msg?.type === 'RADAR_CHECK_DONE') {
        showToast(`動向チェック完了: 🟢動きあり ${msg.active} ／ ⚪動きなし ${msg.quiet}${msg.errors ? ` ／ ⚠ ${msg.errors}` : ''}`);
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
          setErrorBanner(`動画要約に失敗しました: ${msg.error}`);
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
  }, [reload, showToast, setErrorBanner]);

  const enabledTargets = useMemo(() => targets.filter((t) => t.enabled), [targets]);
  const activeCount = enabledTargets.filter((t) => t.status === 'active').length;
  const quietCount = enabledTargets.filter((t) => t.status === 'quiet').length;
  const errorCount = enabledTargets.filter((t) => t.status === 'error').length;
  const offCount = targets.length - enabledTargets.length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return targets
      .filter((t) => {
        if (platformFilter !== 'all' && t.platform !== platformFilter) return false;
        if (filter === 'off') return !t.enabled;
        if (!t.enabled) return false;
        if (filter === 'active') return t.status === 'active';
        if (filter === 'quiet') return t.status === 'quiet';
        return true;
      })
      .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.handle || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const r = statusRank(a) - statusRank(b);
        if (r !== 0) return r;
        return (Date.parse(b.lastActivityAt || '') || 0) - (Date.parse(a.lastActivityAt || '') || 0);
      });
  }, [targets, filter, platformFilter, search]);

  const send = async (msg: RuntimeRequest, okToast?: string) => {
    setErrorBanner('');
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (!res?.ok) setErrorBanner(res?.error || '操作に失敗しました');
      else if (okToast) showToast(okToast);
      return res;
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
      return null;
    }
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

  const handleSummarizeActiveTab = async () => {
    const res = await send({ type: 'SUMMARIZE_ACTIVE_YOUTUBE_TAB' });
    if (res?.ok && typeof res.videoId === 'string') {
      setFocusVideoId(res.videoId);
      setDigestProgress((p) => ({ ...p, [res.videoId]: '開始中...' }));
    }
  };

  const handleAdd = async () => {
    if (!addInput.trim()) return;
    setIsAdding(true);
    const res = await send(
      { type: 'RADAR_ADD_TARGET', platform: addPlatform, input: addInput.trim() },
      '監視対象に追加しました'
    );
    setIsAdding(false);
    if (res?.ok) {
      setAddInput('');
      void reload();
    }
  };

  const toggleTarget = async (t: WatchTarget, enabled: boolean) => {
    await db.watchTargets.update(t.id, { enabled });
    setTargets((prev) => prev.map((p) => (p.id === t.id ? { ...p, enabled } : p)));
  };

  const deleteTarget = async (t: WatchTarget) => {
    await db.watchTargets.delete(t.id);
    setTargets((prev) => prev.filter((p) => p.id !== t.id));
  };

  const bulkSetPlatform = async (platform: WatchPlatform, enabled: boolean) => {
    const ids = targets.filter((t) => t.platform === platform).map((t) => t.id);
    await db.watchTargets.bulkUpdate(ids.map((key) => ({ key, changes: { enabled } })));
    void reload();
  };

  const renderItem = (t: WatchTarget, item: RadarItem, isNew: boolean) => {
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
        {t.platform === 'x' && item.excerpt && item.excerpt !== item.title && (
          <p className="radar-item-excerpt">{item.excerpt}</p>
        )}
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
              {progress ? `⏳ ${progress}` : digest ? (expandedDigest[vid] ? '要約を閉じる' : '要約を見る') : '🧠 要約して判断'}
            </button>
          </div>
        )}
        {vid && digest && expandedDigest[vid] && (
          <DigestCard digest={digest} onRerun={() => handleSummarize(item.url, true)} />
        )}
      </li>
    );
  };

  const focusDigest = focusVideoId ? digests.get(focusVideoId) : undefined;

  return (
    <section aria-label="登録チャンネル・フォロー動向" className="radar-panel">
      <div className="radar-summary">
        <div className="radar-counts">
          <button type="button" className={`count-chip is-active-chip ${filter === 'active' ? 'is-selected' : ''}`} onClick={() => setFilter(filter === 'active' ? 'all' : 'active')}>
            🟢 動きあり <strong>{activeCount}</strong>
          </button>
          <button type="button" className={`count-chip ${filter === 'quiet' ? 'is-selected' : ''}`} onClick={() => setFilter(filter === 'quiet' ? 'all' : 'quiet')}>
            ⚪ 動きなし <strong>{quietCount}</strong>
          </button>
          {errorCount > 0 && <span className="count-chip is-error-chip">⚠ {errorCount}</span>}
        </div>
        <p className="radar-lastrun">
          最終チェック: {lastRunAt ? `${formatRelativeJa(lastRunAt)}（${new Date(lastRunAt).toLocaleString('ja-JP')}）` : '未実行'}
        </p>
        <div className="radar-actions">
          <button
            id="btn-radar-check"
            type="button"
            className="btn-primary"
            disabled={isJobRunning || enabledTargets.length === 0}
            onClick={() => void send({ type: 'RADAR_CHECK' })}
          >
            動向をチェック
          </button>
          <button
            id="btn-radar-episode"
            type="button"
            className="btn-secondary"
            disabled={isJobRunning || enabledTargets.length === 0}
            onClick={() => void send({ type: 'RADAR_GENERATE_EPISODE', checkFirst: !lastRunAt })}
            title="動きあり／なしのサマリーと新着を2人掛け合い番組にします"
          >
            🎙 動向を番組化
          </button>
        </div>
        <button
          id="btn-summarize-active-video"
          type="button"
          className="btn-secondary radar-wide-btn"
          onClick={() => void handleSummarizeActiveTab()}
        >
          ▶ 今開いている YouTube 動画を要約して「見る/見ない」判定
        </button>
        {focusVideoId && digestProgress[focusVideoId] && (
          <p className="radar-progress">⏳ {digestProgress[focusVideoId]}</p>
        )}
        {focusDigest && !digestProgress[focusVideoId!] && (
          <div className="focus-digest">
            <p className="focus-digest-title">
              <a href={focusDigest.url} target="_blank" rel="noreferrer">{focusDigest.title}</a>
              <span> — {focusDigest.channelName}</span>
            </p>
            <DigestCard digest={focusDigest} onRerun={() => handleSummarize(focusDigest.url, true)} />
          </div>
        )}
      </div>

      {targets.length === 0 ? (
        <div className="empty-box radar-empty">
          <p>
            まだ監視対象がありません。下のボタンでログイン中の <strong>YouTube 登録チャンネル</strong> や{' '}
            <strong>X のフォロー</strong> を取り込むか、URL / @ハンドルを直接追加してください。
          </p>
        </div>
      ) : null}

      <div className="radar-import">
        <button
          type="button"
          className="btn-secondary"
          disabled={isJobRunning}
          onClick={() => void send({ type: 'RADAR_IMPORT_YOUTUBE_SUBS' })}
        >
          📺 YouTube 登録チャンネルを取り込む
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={isJobRunning}
          onClick={() => void send({ type: 'RADAR_IMPORT_X_FOLLOWING' })}
        >
          𝕏 X のフォローを取り込む
        </button>
      </div>

      <div className="radar-add">
        <select
          className="field-select"
          value={addPlatform}
          onChange={(e) => setAddPlatform(e.target.value as WatchPlatform)}
          aria-label="追加するプラットフォーム"
        >
          <option value="youtube">YouTube</option>
          <option value="x">X</option>
        </select>
        <input
          className="field-input"
          value={addInput}
          placeholder={addPlatform === 'youtube' ? 'https://www.youtube.com/@handle' : '@handle または https://x.com/handle'}
          onChange={(e) => setAddInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAdd();
          }}
        />
        <button type="button" className="btn-secondary" disabled={isAdding || !addInput.trim()} onClick={() => void handleAdd()}>
          追加
        </button>
      </div>

      {targets.length > 0 && (
        <div className="radar-filters">
          <div className="segmented" role="tablist" aria-label="状態フィルタ">
            {(
              [
                ['all', `すべて (${enabledTargets.length})`],
                ['active', `動きあり (${activeCount})`],
                ['quiet', `動きなし (${quietCount})`],
                ['off', `OFF (${offCount})`],
              ] as [RadarFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segment ${filter === key ? 'is-active' : ''}`}
                onClick={() => {
                  setFilter(key);
                  setVisibleCount(PAGE_SIZE);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="radar-filter-row">
            <select
              className="field-select"
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value as PlatformFilter)}
              aria-label="プラットフォーム"
            >
              <option value="all">全プラットフォーム</option>
              <option value="youtube">YouTube</option>
              <option value="x">X</option>
            </select>
            <input
              className="field-input"
              placeholder="名前で絞り込み"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      <ul className="radar-list">
        {filtered.slice(0, visibleCount).map((t) => {
          const newIds = new Set(t.status === 'active' ? t.latestItems.slice(0, t.newCount).map((i) => i.id) : []);
          return (
            <li key={t.id} className={`radar-target status-${t.enabled ? t.status : 'off'}`}>
              <div className="radar-target-head">
                <span className={`status-dot status-${t.enabled ? t.status : 'off'}`} aria-hidden />
                <a href={t.url} target="_blank" rel="noreferrer" className="radar-target-name">
                  {t.name}
                </a>
                <span className={`platform-badge platform-${t.platform}`}>
                  {t.platform === 'youtube' ? 'YouTube' : 'X'}
                </span>
                <label className="radar-toggle" title="監視ON/OFF">
                  <input type="checkbox" checked={t.enabled} onChange={(e) => void toggleTarget(t, e.target.checked)} />
                </label>
                <button type="button" className="btn-ghost" onClick={() => void deleteTarget(t)} aria-label={`${t.name} を削除`}>
                  ✕
                </button>
              </div>
              <p className="radar-target-status">
                {!t.enabled
                  ? '監視OFF'
                  : t.status === 'active'
                    ? `🟢 新着 ${t.newCount} 件（${formatRelativeJa(t.lastActivityAt)}）`
                    : t.status === 'quiet'
                      ? `⚪ 動きなし（最終投稿: ${formatRelativeJa(t.lastActivityAt)}）`
                      : t.status === 'error'
                        ? `⚠ ${t.statusMessage || '確認できませんでした'}`
                        : '未チェック'}
                {t.lastCheckedAt && <span className="radar-checked"> ・ 確認 {formatRelativeJa(t.lastCheckedAt)}</span>}
              </p>
              {t.enabled && t.latestItems.length > 0 && (
                <ul className="radar-items">
                  {t.latestItems.slice(0, t.status === 'active' ? Math.max(1, Math.min(t.newCount, 5)) : 1).map((item) =>
                    renderItem(t, item, newIds.has(item.id))
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {filtered.length > visibleCount && (
        <button type="button" className="btn-ghost radar-more" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
          さらに表示（残り {filtered.length - visibleCount} 件）
        </button>
      )}

      <details className="extract-details radar-settings">
        <summary>レーダー設定と仕組み</summary>
        <div className="toggle-row">
          <span>「巡回して番組作成」に動向チェックを含める</span>
          <input
            type="checkbox"
            checked={settings.radarIncludeInPatrol}
            onChange={(e) => void onPatchSettings({ radarIncludeInPatrol: e.target.checked })}
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="radar-window">初回チェックで「新着」とみなす期間（時間）</label>
          <input
            id="radar-window"
            type="number"
            min={6}
            max={720}
            className="field-input"
            value={settings.radarWindowHours}
            onChange={(e) => void onPatchSettings({ radarWindowHours: Math.max(6, Number(e.target.value) || 72) })}
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="radar-xmax">1回のチェックで確認する X アカウント数（古い順）</label>
          <input
            id="radar-xmax"
            type="number"
            min={1}
            max={50}
            className="field-input"
            value={settings.radarMaxXAccountsPerRun}
            onChange={(e) => void onPatchSettings({ radarMaxXAccountsPerRun: Math.max(1, Math.min(50, Number(e.target.value) || 12)) })}
          />
        </div>
        <div className="radar-bulk">
          <button type="button" className="btn-ghost" onClick={() => void bulkSetPlatform('youtube', true)}>YouTube を全てON</button>
          <button type="button" className="btn-ghost" onClick={() => void bulkSetPlatform('x', false)}>X を全てOFF</button>
        </div>
        <p className="field-hint">
          <strong>YouTube:</strong> 各チャンネルの公開RSS（feeds/videos.xml）をタブを開かずに並列取得し、前回チェック以降の投稿があれば「動きあり」。
          <br />
          <strong>X:</strong> ログイン中のセッションで「agentCast 巡回中」グループのタブから各プロフィールを順番に表示し、本人の投稿時刻で判定（凍結リスクを避けるため1回あたり上限・間隔あり）。
          <br />
          <strong>動画要約:</strong> 字幕トラック（日本語優先）→ Gemini の動画理解 → 概要欄の順で取得し、関心トピック「{settings.focusTopics}」との関連度から 見る／流し見／スキップ を判定します。
        </p>
      </details>
    </section>
  );
}
