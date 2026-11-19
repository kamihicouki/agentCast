import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db, getSettings, getUnreadQueue } from '../../storage/db';
import {
  DEFAULT_SETTINGS,
  INITIAL_PLAYBACK_STATE,
  SOURCE_META,
  type BuildMeta,
  type ExtensionSettings,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type SourceId,
  type TabGroupSummary,
} from '../../shared/types';
import type { DevBuildStatus, RuntimeRequest } from '../../shared/messages';
import {
  copyEpisodeMarkdown,
  downloadEpisodeAudio,
  downloadPortableHtmlPlayer,
  shareEpisodeNative,
} from '../../shared/export-utils';

type ActiveTab = 'player' | 'queue' | 'settings';

const SPEED_STEPS = [1.0, 1.25, 1.5, 1.75, 2.0];
const GEMINI_VOICES = ['Puck', 'Aoede', 'Kore', 'Charon', 'Fenrir', 'Leda'];

function formatSec(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function App() {
  const [tab, setTab] = useState<ActiveTab>('player');
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [queue, setQueue] = useState<FeedItem[]>([]);
  const [tabGroups, setTabGroups] = useState<TabGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | ''>('');
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK_STATE);
  const [isJobRunning, setIsJobRunning] = useState<boolean>(false);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [currentBuild, setCurrentBuild] = useState<BuildMeta | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildMeta | null>(null);
  const [setupDismissed, setSetupDismissed] = useState<boolean>(false);
  const [isVerifyingKey, setIsVerifyingKey] = useState<boolean>(false);
  const [keyVerifyStatus, setKeyVerifyStatus] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const activeTurnRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? '' : prev));
    }, 3400);
  }, []);

  const refreshTabGroups = useCallback(async () => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_TAB_GROUPS',
      } satisfies RuntimeRequest)) as { ok?: boolean; groups?: TabGroupSummary[] };
      if (res?.ok && Array.isArray(res.groups)) {
        setTabGroups(res.groups);
        setSelectedGroupId((prev) => {
          if (prev !== '' && res.groups!.some((g) => g.id === prev)) return prev;
          return res.groups![0]?.id ?? '';
        });
      }
    } catch {
      // ignore if tabGroups unavailable
    }
  }, []);

  const refreshData = useCallback(async () => {
    const [eps, unread, savedSettings] = await Promise.all([
      db.episodes.orderBy('createdAt').reverse().limit(30).toArray(),
      getUnreadQueue(80),
      getSettings(),
    ]);
    setEpisodes(eps);
    setQueue(unread);
    setSettings(savedSettings);
    setSelectedEpisodeId((prev) => {
      if (prev && eps.some((e) => e.id === prev)) return prev;
      return eps[0]?.id || null;
    });
  }, []);

  useEffect(() => {
    void refreshData();
    void refreshTabGroups();

    chrome.runtime
      .sendMessage({ type: 'GET_PLAYBACK_STATE' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.state) setPlayback(res.state);
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({ type: 'GET_JOB_STATUS' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.ok) {
          setIsJobRunning(Boolean(res.isJobRunning));
          if (res.message) setBusyMessage(res.message);
          if (res.lastError) setErrorBanner(res.lastError);
        }
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({ type: 'GET_DEV_BUILD_STATUS' } satisfies RuntimeRequest)
      .then((res: { status?: DevBuildStatus }) => {
        if (res?.status?.currentBuild) setCurrentBuild(res.status.currentBuild);
        if (res?.status?.pendingBuild) setPendingBuild(res.status.pendingBuild);
      })
      .catch(() => {});

    const onRuntimeMessage = (msg: Record<string, unknown>) => {
      if (msg?.type === 'PLAYBACK_STATE_UPDATED' && msg.state) {
        const nextState = msg.state as PlaybackState;
        setPlayback(nextState);
        if (nextState.episodeId) {
          setSelectedEpisodeId(nextState.episodeId);
        }
      } else if (msg?.type === 'EPISODES_UPDATED') {
        void db.episodes
          .orderBy('createdAt')
          .reverse()
          .limit(30)
          .toArray()
          .then((eps) => {
            setEpisodes(eps);
            if (typeof msg.episodeId === 'string' && eps.some((e) => e.id === msg.episodeId)) {
              setSelectedEpisodeId(msg.episodeId);
            } else {
              setSelectedEpisodeId((prev) =>
                prev && eps.some((e) => e.id === prev) ? prev : eps[0]?.id || null
              );
            }
          });
      } else if (msg?.type === 'QUEUE_UPDATED') {
        void getUnreadQueue(80).then(setQueue);
      } else if (msg?.type === 'PATROL_PROGRESS') {
        setBusyMessage(typeof msg.message === 'string' ? msg.message : '');
        if (typeof msg.isJobRunning === 'boolean') {
          setIsJobRunning(msg.isJobRunning);
        }
      } else if (msg?.type === 'JOB_ERROR' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
        setIsJobRunning(false);
        setBusyMessage('');
      } else if (msg?.type === 'JOB_WARNING' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
      } else if (msg?.type === 'JOB_FINISHED') {
        setIsJobRunning(false);
        setBusyMessage('');
        void refreshData();
        void refreshTabGroups();
      } else if (msg?.type === 'DEV_BUILD_UPDATE_AVAILABLE' && msg.pendingBuild) {
        setPendingBuild(msg.pendingBuild as BuildMeta);
      } else if (msg?.type === 'GEMINI_KEY_SETUP_DONE') {
        void getSettings().then(setSettings);
        setErrorBanner('');
        const text =
          typeof msg.message === 'string'
            ? msg.message
            : 'Gemini API キーを設定しました！';
        setKeyVerifyStatus({ ok: true, text });
        showToast(text);
      }
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, [refreshData, refreshTabGroups, showToast]);

  useEffect(() => {
    if (playback.isPlaying && activeTurnRef.current) {
      activeTurnRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [playback.turnIndex, playback.chapterIndex, playback.isPlaying]);

  const displayedEpisode = useMemo(() => {
    return episodes.find((e) => e.id === selectedEpisodeId) || episodes[0] || null;
  }, [episodes, selectedEpisodeId]);

  const isSelectedPlayingEpisode =
    displayedEpisode && playback.episodeId === displayedEpisode.id;

  const displayedChapterIndex = isSelectedPlayingEpisode ? playback.chapterIndex : 0;
  const displayedChapter =
    displayedEpisode?.chapters[displayedChapterIndex] || displayedEpisode?.chapters[0] || null;

  const hasAudioExportable = Boolean(
    displayedEpisode?.chapters.some((ch) => ch.hasAudioBlob)
  );

  const staleCount = useMemo(
    () =>
      episodes.filter(
        (e) =>
          e.status === 'error' ||
          (!isJobRunning &&
            (e.status === 'generating_script' ||
              e.status === 'synthesizing_audio' ||
              e.status === 'collecting'))
      ).length,
    [episodes, isJobRunning]
  );

  const handleCaptureActiveTab = async () => {
    setErrorBanner('');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CAPTURE_ACTIVE_TAB',
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || 'タブの読み取りに失敗しました');
      } else if (res.warning) {
        setErrorBanner(res.warning);
      } else {
        showToast(`今のタブから ${res.inserted} 件の新着をキューに追加しました`);
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCaptureAndGenerateActiveTab = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_GENERATE_ACTIVE_TAB',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '現在のタブの番組化を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handlePatrolAndGenerate = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'PATROL_AND_GENERATE',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '番組生成を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handlePatrolTabGroup = async () => {
    if (selectedGroupId === '') return;
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'PATROL_TAB_GROUP',
      groupId: Number(selectedGroupId),
      generateAfter: true,
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || 'タブグループ巡回を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handleGenerateFromQueueOnly = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_EPISODE_FROM_QUEUE',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '番組生成を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handleDeleteCurrentEpisode = async () => {
    if (!displayedEpisode) return;
    await chrome.runtime.sendMessage({
      type: 'DELETE_EPISODE',
      episodeId: displayedEpisode.id,
    } satisfies RuntimeRequest);
    showToast('エピソードを削除しました');
    await refreshData();
  };

  const handleCleanupStale = async () => {
    const res = await chrome.runtime.sendMessage({
      type: 'CLEANUP_STALE_EPISODES',
    } satisfies RuntimeRequest);
    showToast(`${res?.removed ?? 0} 件の未完了エピソードを整理しました`);
    await refreshData();
  };

  const handleDownloadAudio = async () => {
    if (!displayedEpisode) return;
    try {
      const ok = await downloadEpisodeAudio(displayedEpisode);
      if (ok) {
        showToast('結合済みポッドキャスト音声を保存しました');
      } else {
        setErrorBanner(
          'このエピソードはWeb Speech再生専用のため音声ファイルがありません。HTMLまたはMarkdown保存をご利用ください。'
        );
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadHtml = async () => {
    if (!displayedEpisode) return;
    try {
      await downloadPortableHtmlPlayer(displayedEpisode);
      showToast('音声＆台本入りポータブルHTMLを保存しました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyMarkdown = async () => {
    if (!displayedEpisode) return;
    try {
      await copyEpisodeMarkdown(displayedEpisode);
      showToast('台本と参照リンク集（Markdown）をコピーしました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleShareEpisode = async () => {
    if (!displayedEpisode) return;
    try {
      const outcome = await shareEpisodeNative(displayedEpisode);
      showToast(
        outcome === 'shared'
          ? '共有シートを開きました'
          : '台本＆リンク集をクリップボードにコピーしました'
      );
    } catch (err) {
      // User canceling native share sheet is not an error
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePlayChapter = async (episodeId: string, chapterIndex = 0) => {
    setSelectedEpisodeId(episodeId);
    await chrome.runtime.sendMessage({
      type: 'PLAY_EPISODE',
      episodeId,
      chapterIndex,
    } satisfies RuntimeRequest);
  };

  const handlePlayPause = async () => {
    if (!displayedEpisode) return;
    if (playback.episodeId !== displayedEpisode.id) {
      await handlePlayChapter(displayedEpisode.id, 0);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'TOGGLE_PLAY_PAUSE' } satisfies RuntimeRequest);
  };

  const handleCycleSpeed = async () => {
    const currentIdx = SPEED_STEPS.findIndex((s) => Math.abs(s - playback.playbackRate) < 0.05);
    const nextRate = SPEED_STEPS[(currentIdx + 1) % SPEED_STEPS.length];
    await chrome.runtime.sendMessage({
      type: 'SET_PLAYBACK_RATE',
      rate: nextRate,
    } satisfies RuntimeRequest);
  };

  const handlePatchSettings = async (patch: Partial<ExtensionSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: patch,
    } satisfies RuntimeRequest);
  };

  const handleStartGeminiKeySetup = async () => {
    setErrorBanner('');
    setKeyVerifyStatus(null);
    const res = await chrome.runtime.sendMessage({
      type: 'START_GEMINI_KEY_SETUP',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || 'Google AI Studio を開けませんでした');
    } else {
      showToast('Google AI Studio を開きました。右下のガイドから1クリックで設定できます');
    }
  };

  const handlePasteKeyFromClipboard = async () => {
    setErrorBanner('');
    setIsVerifyingKey(true);
    try {
      const text = await navigator.clipboard.readText();
      const match = /\b(AIza[0-9A-Za-z_-]{35})\b/.exec(text || '');
      if (!match?.[1]) {
        const msg =
          'クリップボードに Gemini API キー（AIza...）が見つかりません。AI Studio でキーをコピーしてから押してください。';
        setKeyVerifyStatus({ ok: false, text: msg });
        setErrorBanner(msg);
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: 'GEMINI_KEY_CAPTURED',
        apiKey: match[1],
      } satisfies RuntimeRequest);
      if (res?.ok) {
        const saved = await getSettings();
        setSettings(saved);
        const msg = res.message || '接続テスト成功！キーを保存しました。';
        setKeyVerifyStatus({ ok: true, text: msg });
        showToast(msg);
      } else {
        const msg = res?.error || 'APIキーの検証に失敗しました';
        setKeyVerifyStatus({ ok: false, text: msg });
        setErrorBanner(msg);
      }
    } catch (err) {
      setErrorBanner(
        `クリップボードの読み取りに失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setIsVerifyingKey(false);
    }
  };

  const handleVerifyGeminiKey = async () => {
    setErrorBanner('');
    setIsVerifyingKey(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VERIFY_GEMINI_KEY',
        apiKey: settings.geminiApiKey,
      } satisfies RuntimeRequest);
      const text = res?.message || (res?.ok ? '接続テスト成功！' : '接続テストに失敗しました');
      setKeyVerifyStatus({ ok: Boolean(res?.ok), text });
      if (res?.ok) showToast(text);
    } catch (err) {
      setKeyVerifyStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsVerifyingKey(false);
    }
  };

  const handleRemoveQueueItem = async (id: string) => {
    await db.feedItems.delete(id);
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const handleClearQueue = async () => {
    const ids = queue.map((q) => q.id);
    await db.feedItems.bulkDelete(ids);
    setQueue([]);
  };

  const progressPct =
    isSelectedPlayingEpisode && playback.durationSec > 0
      ? Math.min(100, (playback.currentTimeSec / playback.durationSec) * 100)
      : 0;

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-row">
          <h1 className="brand-title">
            <span className="brand-mark" aria-hidden="true" />
            agentCast
          </h1>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {staleCount > 0 && (
              <button
                id="btn-cleanup-stale"
                type="button"
                className="btn-ghost"
                onClick={handleCleanupStale}
                title="中断された未完了エピソードを一括削除"
              >
                未完了整理 ({staleCount})
              </button>
            )}
            {pendingBuild && (
              <button
                id="btn-apply-hot-reload"
                type="button"
                className="reload-notice-btn"
                onClick={() =>
                  chrome.runtime.sendMessage({
                    type: 'TRIGGER_DEV_RELOAD_NOW',
                  } satisfies RuntimeRequest)
                }
              >
                更新反映
              </button>
            )}
          </div>
        </div>

        <div className="action-strip">
          <button
            id="btn-patrol-and-generate"
            type="button"
            className="btn-primary"
            disabled={isJobRunning}
            onClick={handlePatrolAndGenerate}
            title="登録5サイトを専用タブグループで巡回して番組を生成"
          >
            巡回して番組作成
          </button>
          <button
            id="btn-instant-active-tab"
            type="button"
            className="btn-secondary"
            disabled={isJobRunning}
            onClick={handleCaptureAndGenerateActiveTab}
            title="現在開いているページ（Changelogや記事等）だけで即座に1番組を作成"
          >
            今のタブを番組化
          </button>
          <button
            id="btn-capture-active-tab"
            type="button"
            className="btn-secondary"
            disabled={isJobRunning}
            onClick={handleCaptureActiveTab}
            title="現在開いているタブの記事を未読キューに追加"
          >
            ＋キュー
          </button>
        </div>

        {tabGroups.length > 0 && (
          <div className="tabgroup-strip">
            <select
              id="select-tab-group"
              className="episode-select"
              value={selectedGroupId}
              onChange={(e) => setSelectedGroupId(Number(e.target.value))}
              aria-label="巡回するタブグループを選択"
            >
              {tabGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  📁 {g.title} ({g.tabCount}タブ)
                </option>
              ))}
            </select>
            <button
              id="btn-patrol-tab-group"
              type="button"
              className="btn-secondary"
              disabled={isJobRunning || selectedGroupId === ''}
              onClick={handlePatrolTabGroup}
              title="選択したタブグループ内の全タブを巡回して番組を作成"
            >
              グループ番組化
            </button>
            <button
              id="btn-refresh-tab-groups"
              type="button"
              className="btn-ghost"
              onClick={() => void refreshTabGroups()}
              title="タブグループ一覧を更新"
              aria-label="タブグループ一覧を更新"
            >
              ↻
            </button>
          </div>
        )}

        <nav className="nav-tabs" aria-label="メインナビゲーション">
          <button
            id="tab-player"
            type="button"
            className={`nav-tab ${tab === 'player' ? 'is-active' : ''}`}
            onClick={() => setTab('player')}
          >
            再生・台本
          </button>
          <button
            id="tab-queue"
            type="button"
            className={`nav-tab ${tab === 'queue' ? 'is-active' : ''}`}
            onClick={() => setTab('queue')}
          >
            未読キュー ({queue.length})
          </button>
          <button
            id="tab-settings"
            type="button"
            className={`nav-tab ${tab === 'settings' ? 'is-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            設定
          </button>
        </nav>

        {(busyMessage || toastMessage || displayedEpisode?.statusDetail) && (
          <div className="status-banner" role="status">
            <span>{busyMessage || toastMessage || displayedEpisode?.statusDetail}</span>
          </div>
        )}

        {(errorBanner || displayedEpisode?.errorMessage) && (
          <div className="status-banner is-error" role="alert">
            <span>{errorBanner || displayedEpisode?.errorMessage}</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setErrorBanner('')}
              aria-label="エラー表示を閉じる"
            >
              ✕
            </button>
          </div>
        )}
      </header>

      <main className="studio-main">
        {tab === 'player' && (
          <>
            {!settings.geminiApiKey.trim() &&
              settings.aiMode === 'gemini_api' &&
              !setupDismissed && (
                <section className="onboarding-card" aria-label="初回APIキーかんたん設定">
                  <div className="onboarding-header">
                    <h2 className="onboarding-title">Google AI Pro / Ultra 初回セットアップ</h2>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setSetupDismissed(true)}
                      aria-label="セットアップ案内を閉じる"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="onboarding-desc">
                    AI Studio
                    を開いてキーを作成・表示するだけで、agentCast
                    が自動検出して保存＆接続テストまで半自動で完了します。
                  </p>
                  <div className="onboarding-actions">
                    <button
                      id="btn-onboarding-start-aistudio"
                      type="button"
                      className="btn-primary"
                      onClick={handleStartGeminiKeySetup}
                    >
                      AI Studio を開いてキーを半自動設定
                    </button>
                    <div className="onboarding-sub-row">
                      <button
                        id="btn-onboarding-paste-key"
                        type="button"
                        className="btn-secondary"
                        disabled={isVerifyingKey}
                        onClick={handlePasteKeyFromClipboard}
                      >
                        {isVerifyingKey ? '接続テスト中...' : '📋 クリップボードから貼付＆テスト'}
                      </button>
                      <button
                        id="btn-onboarding-use-web"
                        type="button"
                        className="btn-ghost"
                        onClick={() =>
                          void handlePatchSettings({
                            aiMode: 'web_gemini',
                            ttsMode: 'macos_speech',
                          })
                        }
                        title="APIキーを使わずにログイン済み Gemini Web セッションで生成"
                      >
                        キーなしWeb連携
                      </button>
                    </div>
                  </div>
                </section>
              )}
            {displayedEpisode ? (
              <>
                <section className="player-deck" aria-label="ポッドキャスト再生デッキ">
                  <div className="episode-picker-row">
                    <select
                      id="select-episode"
                      className="episode-select"
                      value={displayedEpisode.id}
                      onChange={(e) => setSelectedEpisodeId(e.target.value)}
                      aria-label="エピソード選択"
                    >
                      {episodes.map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {ep.title}
                        </option>
                      ))}
                    </select>
                    <button
                      id="btn-playback-speed"
                      type="button"
                      className="ctrl-btn"
                      onClick={handleCycleSpeed}
                      title="再生速度を切り替え"
                    >
                      {playback.playbackRate.toFixed(2).replace(/\.00$/, '.0')}x
                    </button>
                    <button
                      id="btn-delete-episode"
                      type="button"
                      className="ctrl-btn"
                      onClick={handleDeleteCurrentEpisode}
                      title="このエピソードを削除"
                      aria-label="このエピソードを削除"
                    >
                      🗑
                    </button>
                  </div>

                  {displayedChapter ? (
                    <>
                      <div className="chapter-kicker">
                        CHAPTER {displayedChapter.index + 1} / {displayedEpisode.chapters.length} ·{' '}
                        {displayedEpisode.ttsEngineLabel}
                      </div>
                      <h2 className="chapter-heading">{displayedChapter.title}</h2>
                      {displayedChapter.summary && (
                        <p className="chapter-sub">{displayedChapter.summary}</p>
                      )}
                    </>
                  ) : (
                    <p className="chapter-sub">{displayedEpisode.subtitle}</p>
                  )}

                  <div className="progress-track" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                  <div className="time-row">
                    <span>
                      {isSelectedPlayingEpisode ? formatSec(playback.currentTimeSec) : '00:00'}
                    </span>
                    <span>
                      {isSelectedPlayingEpisode
                        ? formatSec(playback.durationSec)
                        : formatSec(
                            displayedChapter?.durationSec || displayedEpisode.totalDurationSec
                          )}
                    </span>
                  </div>

                  <div className="transport-row">
                    <button
                      id="btn-prev-chapter"
                      type="button"
                      className="ctrl-btn"
                      onClick={() =>
                        chrome.runtime.sendMessage({
                          type: 'SKIP_CHAPTER',
                          delta: -1,
                        } satisfies RuntimeRequest)
                      }
                      title="前のチャプターへ"
                    >
                      ⏮ 前話
                    </button>

                    <div className="transport-center">
                      <button
                        id="btn-seek-back"
                        type="button"
                        className="ctrl-btn"
                        onClick={() =>
                          chrome.runtime.sendMessage({
                            type: 'SEEK_RELATIVE',
                            deltaSec: -15,
                          } satisfies RuntimeRequest)
                        }
                        title="15秒戻す"
                      >
                        -15s
                      </button>

                      <button
                        id="btn-play-pause"
                        type="button"
                        className="ctrl-btn ctrl-btn-play"
                        onClick={handlePlayPause}
                        aria-label={
                          isSelectedPlayingEpisode && playback.isPlaying ? '一時停止' : '再生'
                        }
                      >
                        {isSelectedPlayingEpisode && playback.isPlaying ? '⏸' : '▶'}
                      </button>

                      <button
                        id="btn-seek-forward"
                        type="button"
                        className="ctrl-btn"
                        onClick={() =>
                          chrome.runtime.sendMessage({
                            type: 'SEEK_RELATIVE',
                            deltaSec: 15,
                          } satisfies RuntimeRequest)
                        }
                        title="15秒進める"
                      >
                        +15s
                      </button>
                    </div>

                    <button
                      id="btn-next-chapter"
                      type="button"
                      className="ctrl-btn"
                      onClick={() =>
                        chrome.runtime.sendMessage({
                          type: 'SKIP_CHAPTER',
                          delta: 1,
                        } satisfies RuntimeRequest)
                      }
                      title="次のチャプターへスキップ（Bluetoothイヤホンの次曲操作に対応）"
                    >
                      次話 ⏭
                    </button>
                  </div>

                  <div className="share-strip" aria-label="番組の保存と共有">
                    <button
                      id="btn-export-audio"
                      type="button"
                      className="share-btn"
                      disabled={!hasAudioExportable}
                      onClick={handleDownloadAudio}
                      title="全チャプターを結合した音声ファイル（WAV/MP3）を保存"
                    >
                      音声保存
                    </button>
                    <button
                      id="btn-export-html"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleDownloadHtml}
                      title="音声＋台本＋リンクが1ファイルに収まった単体プレイヤーHTMLを保存"
                    >
                      HTML保存
                    </button>
                    <button
                      id="btn-copy-markdown"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleCopyMarkdown}
                      title="台本と参照元URLをMarkdown形式でコピー"
                    >
                      台本コピー
                    </button>
                    <button
                      id="btn-share-episode"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleShareEpisode}
                      title="macOS共有シート（AirDrop等）またはクリップボードで共有"
                    >
                      共有 ↗
                    </button>
                  </div>

                  <div className="bt-hint">
                    <span>Bluetooth「次の曲」操作 ＝ 次の話題チャプターへスキップ</span>
                  </div>
                </section>

                {displayedEpisode.chapters.length > 1 && (
                  <section className="chapter-strip" aria-label="チャプター一覧">
                    {displayedEpisode.chapters.map((ch) => {
                      const isCurrent = ch.index === displayedChapterIndex;
                      return (
                        <button
                          key={ch.id}
                          type="button"
                          className={`chapter-row-btn ${isCurrent ? 'is-current' : ''}`}
                          onClick={() => handlePlayChapter(displayedEpisode.id, ch.index)}
                        >
                          <span>
                            <span className="chapter-idx">
                              {String(ch.index + 1).padStart(2, '0')}
                            </span>
                            {ch.title}
                          </span>
                          <span className="chapter-idx">{formatSec(ch.durationSec)}</span>
                        </button>
                      );
                    })}
                  </section>
                )}

                {displayedChapter && displayedChapter.sourceItems.length > 0 && (
                  <div className="sources-box" aria-label="参照元リンク">
                    {displayedChapter.sourceItems.map((src) => (
                      <a
                        key={src.id}
                        className="source-link-chip"
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        title={src.title}
                      >
                        <span className="source-tag">
                          {SOURCE_META[src.source]?.shortLabel || src.source}
                        </span>
                        <span className="source-link-title">{src.title}</span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                  </div>
                )}

                {displayedChapter && (
                  <section className="transcript-list" aria-label="番組台本">
                    {displayedChapter.turns.map((turn, idx) => {
                      const isSpeaking =
                        Boolean(isSelectedPlayingEpisode) &&
                        playback.isPlaying &&
                        playback.turnIndex === idx;
                      return (
                        <div
                          key={turn.id}
                          ref={isSpeaking ? activeTurnRef : null}
                          className={`turn-item ${isSpeaking ? 'is-speaking' : ''}`}
                        >
                          <span
                            className={`speaker-label ${
                              turn.speaker === 'HostA' ? 'host-a' : 'host-b'
                            }`}
                          >
                            {turn.speakerName}
                          </span>
                          <p className="turn-text">{turn.text}</p>
                        </div>
                      );
                    })}
                  </section>
                )}
              </>
            ) : (
              <div className="empty-box">
                <p>まだエピソードがありません。</p>
                <button
                  id="btn-create-demo"
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    chrome.runtime.sendMessage({
                      type: 'CREATE_DEMO_EPISODE',
                    } satisfies RuntimeRequest)
                  }
                >
                  サウンドチェック番組を再生する
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'queue' && (
          <section aria-label="未読ストック一覧">
            <div className="section-toolbar">
              <button
                id="btn-generate-from-queue"
                type="button"
                className="btn-primary"
                disabled={queue.length === 0 || isJobRunning}
                onClick={handleGenerateFromQueueOnly}
              >
                キュー ({queue.length}件) から番組作成
              </button>
              {queue.length > 0 && (
                <button
                  id="btn-clear-queue"
                  type="button"
                  className="btn-ghost"
                  onClick={handleClearQueue}
                >
                  すべてクリア
                </button>
              )}
            </div>

            {queue.length === 0 ? (
              <div className="empty-box">
                <p>
                  未読キューは空です。X・Note・Zenn・Yahoo!・Google Newsを普段通り閲覧するか、「＋キュー」「巡回して番組作成」を押すとここに記事が貯まります。
                </p>
              </div>
            ) : (
              <div className="queue-list">
                {queue.map((item) => (
                  <article key={item.id} className="queue-item">
                    <div className="queue-meta">
                      <span>
                        [{SOURCE_META[item.source]?.shortLabel || item.source}] {item.author}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => handleRemoveQueueItem(item.id)}
                      >
                        除外
                      </button>
                    </div>
                    <h3 className="queue-title">
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.title}
                      </a>
                    </h3>
                    <p className="queue-excerpt">{item.excerpt}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <section aria-label="設定">
            <div className="settings-group">
              <h2 className="settings-group-title">AI・音声合成プラン設定</h2>

              <div className="field-row">
                <label className="field-label" htmlFor="select-ai-mode">
                  台本生成エンジン（契約プランに合わせて選択）
                </label>
                <select
                  id="select-ai-mode"
                  className="field-select"
                  value={settings.aiMode}
                  onChange={(e) => {
                    const nextAi = e.target.value as ExtensionSettings['aiMode'];
                    const suggestedTts: ExtensionSettings['ttsMode'] =
                      nextAi === 'gemini_api'
                        ? 'gemini_tts'
                        : nextAi === 'openai_api'
                        ? 'openai_tts'
                        : 'macos_speech';
                    void handlePatchSettings({ aiMode: nextAi, ttsMode: suggestedTts });
                  }}
                >
                  <option value="gemini_api">
                    Google AI Pro/Ultra 推奨：Gemini API 直結 (クレジット/無料枠)
                  </option>
                  <option value="web_chatgpt">
                    ChatGPT Plus/Pro：ログイン済み Web セッション連携 (APIキー不要)
                  </option>
                  <option value="web_gemini">
                    Google AI Pro/Ultra：Gemini Web セッション連携 (APIキー不要)
                  </option>
                  <option value="openai_api">OpenAI API キー直結 (BYOK)</option>
                </select>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="select-tts-mode">
                  音声合成（TTS）エンジン
                </label>
                <select
                  id="select-tts-mode"
                  className="field-select"
                  value={settings.ttsMode}
                  onChange={(e) =>
                    void handlePatchSettings({
                      ttsMode: e.target.value as ExtensionSettings['ttsMode'],
                    })
                  }
                >
                  <option value="gemini_tts">
                    Gemini Multi-Speaker TTS（2人掛け合いネイティブ高音質）
                  </option>
                  <option value="macos_speech">
                    macOS Web Speech（完全無料・APIキー不要で即時再生）
                  </option>
                  <option value="openai_tts">OpenAI Multi-Voice TTS</option>
                </select>
              </div>

              {(settings.aiMode === 'gemini_api' || settings.ttsMode === 'gemini_tts') && (
                <div className="field-row">
                  <label className="field-label" htmlFor="input-gemini-key">
                    Gemini API Key (Google AI Studio / Developer Program特典枠)
                  </label>
                  <input
                    id="input-gemini-key"
                    type="password"
                    className="field-input"
                    placeholder="AIzaSy..."
                    value={settings.geminiApiKey}
                    onChange={(e) => {
                      setKeyVerifyStatus(null);
                      void handlePatchSettings({ geminiApiKey: e.target.value });
                    }}
                  />
                  <div className="key-tools-row">
                    <button
                      id="btn-settings-aistudio-setup"
                      type="button"
                      className="btn-primary"
                      onClick={handleStartGeminiKeySetup}
                    >
                      AI Studio で半自動取得
                    </button>
                    <button
                      id="btn-settings-paste-key"
                      type="button"
                      className="btn-secondary"
                      disabled={isVerifyingKey}
                      onClick={handlePasteKeyFromClipboard}
                    >
                      📋 貼付＆テスト
                    </button>
                    <button
                      id="btn-settings-verify-key"
                      type="button"
                      className="btn-secondary"
                      disabled={isVerifyingKey || !settings.geminiApiKey.trim()}
                      onClick={handleVerifyGeminiKey}
                    >
                      {isVerifyingKey ? '確認中...' : '接続テスト'}
                    </button>
                  </div>
                  {keyVerifyStatus && (
                    <div
                      className={`key-status ${keyVerifyStatus.ok ? 'is-ok' : 'is-err'}`}
                      role="status"
                    >
                      {keyVerifyStatus.text}
                    </div>
                  )}
                  <p className="field-hint">
                    ローカル（chrome.storage.local）にのみ保存されます。Google AI Pro/Ultra
                    の月次クレジットは{' '}
                    <a
                      href="https://developers.google.com/profile"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google Developer Program
                    </a>{' '}
                    から有効化できます。未入力時は音声が自動的に macOS Web Speech
                    へフォールバックします。
                  </p>
                </div>
              )}

              {(settings.aiMode === 'openai_api' || settings.ttsMode === 'openai_tts') && (
                <div className="field-row">
                  <label className="field-label" htmlFor="input-openai-key">
                    OpenAI API Key
                  </label>
                  <input
                    id="input-openai-key"
                    type="password"
                    className="field-input"
                    placeholder="sk-..."
                    value={settings.openaiApiKey}
                    onChange={(e) => void handlePatchSettings({ openaiApiKey: e.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">パーソナリティ・番組構成</h2>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-host-a">
                    メイン進行 (HostA)
                  </label>
                  <input
                    id="input-host-a"
                    type="text"
                    className="field-input"
                    value={settings.hostAName}
                    onChange={(e) => void handlePatchSettings({ hostAName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="select-voice-a">
                    HostA ボイス
                  </label>
                  <select
                    id="select-voice-a"
                    className="field-select"
                    value={settings.hostAVoice}
                    onChange={(e) => void handlePatchSettings({ hostAVoice: e.target.value })}
                  >
                    {GEMINI_VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-host-b">
                    パートナー (HostB)
                  </label>
                  <input
                    id="input-host-b"
                    type="text"
                    className="field-input"
                    value={settings.hostBName}
                    onChange={(e) => void handlePatchSettings({ hostBName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="select-voice-b">
                    HostB ボイス
                  </label>
                  <select
                    id="select-voice-b"
                    className="field-select"
                    value={settings.hostBVoice}
                    onChange={(e) => void handlePatchSettings({ hostBVoice: e.target.value })}
                  >
                    {GEMINI_VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="select-duration">
                  番組の目標尺
                </label>
                <select
                  id="select-duration"
                  className="field-select"
                  value={settings.targetDurationMin}
                  onChange={(e) =>
                    void handlePatchSettings({
                      targetDurationMin: Number(e.target.value) as 5 | 10 | 15,
                    })
                  }
                >
                  <option value={5}>約 5 分（ヘッドライン速報）</option>
                  <option value={10}>約 10 分（標準バランス）</option>
                  <option value={15}>約 15 分（じっくり深掘り）</option>
                </select>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="input-focus-topics">
                  重点ピックアップテーマ
                </label>
                <input
                  id="input-focus-topics"
                  type="text"
                  className="field-input"
                  value={settings.focusTopics}
                  onChange={(e) => void handlePatchSettings({ focusTopics: e.target.value })}
                />
              </div>
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">巡回・受動ストック対象サイト</h2>
              {(['x', 'note', 'zenn', 'yahoo_news', 'google_news'] as SourceId[]).map((srcId) => (
                <div key={srcId} className="toggle-row">
                  <div>
                    <div>{SOURCE_META[srcId].label}</div>
                    <p className="field-hint">{SOURCE_META[srcId].description}</p>
                  </div>
                  <input
                    id={`toggle-source-${srcId}`}
                    type="checkbox"
                    checked={Boolean(settings.enabledSources[srcId])}
                    onChange={(e) =>
                      void handlePatchSettings({
                        enabledSources: {
                          ...settings.enabledSources,
                          [srcId]: e.target.checked,
                        },
                      })
                    }
                  />
                </div>
              ))}

              <div className="toggle-row">
                <div>
                  <div>ブラウジング中の自動受動ストック</div>
                  <p className="field-hint">
                    普段Xや記事をスクロールしている間に未読キューへ自動蓄積
                  </p>
                </div>
                <input
                  id="toggle-passive-capture"
                  type="checkbox"
                  checked={settings.passiveCaptureEnabled}
                  onChange={(e) =>
                    void handlePatchSettings({ passiveCaptureEnabled: e.target.checked })
                  }
                />
              </div>

              <div className="toggle-row">
                <div>
                  <div>毎日の定時自動編成 ({settings.autoScheduleTime})</div>
                  <p className="field-hint">指定時刻に自動で巡回・番組生成を実行</p>
                </div>
                <input
                  id="toggle-auto-schedule"
                  type="checkbox"
                  checked={settings.autoScheduleEnabled}
                  onChange={(e) =>
                    void handlePatchSettings({ autoScheduleEnabled: e.target.checked })
                  }
                />
              </div>
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">開発ビルド情報 (Cloud ⇄ Local Auto-Reload)</h2>
              <p className="field-hint">
                Build ID: {currentBuild?.buildId || 'dev'}
                <br />
                クラウド更新が同期されると待機中に自動で chrome.runtime.reload() されます。
              </p>
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <button
                  id="btn-force-reload"
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    chrome.runtime.sendMessage({
                      type: 'TRIGGER_DEV_RELOAD_NOW',
                    } satisfies RuntimeRequest)
                  }
                >
                  拡張機能を今すぐリロード
                </button>
                <button
                  id="btn-play-soundcheck"
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setTab('player');
                    void chrome.runtime.sendMessage({
                      type: 'CREATE_DEMO_EPISODE',
                    } satisfies RuntimeRequest);
                  }}
                >
                  テスト番組を生成
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
