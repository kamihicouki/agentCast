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
} from '../../shared/types';
import type { DevBuildStatus, RuntimeRequest } from '../../shared/messages';

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
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK_STATE);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [currentBuild, setCurrentBuild] = useState<BuildMeta | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildMeta | null>(null);

  const activeTurnRef = useRef<HTMLDivElement | null>(null);

  const refreshData = useCallback(async () => {
    const [eps, unread, savedSettings] = await Promise.all([
      db.episodes.orderBy('createdAt').reverse().limit(30).toArray(),
      getUnreadQueue(80),
      getSettings(),
    ]);
    setEpisodes(eps);
    setQueue(unread);
    setSettings(savedSettings);
    setSelectedEpisodeId((prev) => prev || eps[0]?.id || null);
  }, []);

  useEffect(() => {
    void refreshData();

    chrome.runtime
      .sendMessage({ type: 'GET_PLAYBACK_STATE' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.state) setPlayback(res.state);
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
            if (typeof msg.episodeId === 'string') {
              setSelectedEpisodeId(msg.episodeId);
            }
          });
      } else if (msg?.type === 'QUEUE_UPDATED') {
        void getUnreadQueue(80).then(setQueue);
      } else if (msg?.type === 'PATROL_PROGRESS') {
        setBusyMessage(typeof msg.message === 'string' ? msg.message : '');
      } else if (msg?.type === 'DEV_BUILD_UPDATE_AVAILABLE' && msg.pendingBuild) {
        setPendingBuild(msg.pendingBuild as BuildMeta);
      }
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, [refreshData]);

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

  const handleCaptureActiveTab = async () => {
    setErrorBanner('');
    setBusyMessage('現在のタブから記事・ポストを読み取り中...');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CAPTURE_ACTIVE_TAB',
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || 'タブの読み取りに失敗しました');
      } else if (res.warning) {
        setErrorBanner(res.warning);
      } else {
        setBusyMessage(`現在のタブから ${res.inserted} 件の新着をキューに追加しました`);
        setTimeout(() => setBusyMessage(''), 2600);
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setTimeout(() => setBusyMessage((m) => (m.includes('読み取り中') ? '' : m)), 300);
    }
  };

  const handlePatrolAndGenerate = async () => {
    setErrorBanner('');
    setTab('player');
    setBusyMessage('フォロー中サイトを巡回して番組を編成しています...');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'PATROL_AND_GENERATE',
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || '番組生成に失敗しました');
      } else if (Array.isArray(res.warnings) && res.warnings.length > 0) {
        setErrorBanner(res.warnings.join(' / '));
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage('');
    }
  };

  const handleGenerateFromQueueOnly = async () => {
    setErrorBanner('');
    setTab('player');
    setBusyMessage('未読キューのネタから番組台本・音声を生成中...');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_EPISODE_FROM_QUEUE',
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || '番組生成に失敗しました');
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMessage('');
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
              更新あり・クリックで反映
            </button>
          )}
        </div>

        <div className="action-strip">
          <button
            id="btn-patrol-and-generate"
            type="button"
            className="btn-primary"
            disabled={Boolean(busyMessage)}
            onClick={handlePatrolAndGenerate}
          >
            巡回して番組作成
          </button>
          <button
            id="btn-capture-active-tab"
            type="button"
            className="btn-secondary"
            disabled={Boolean(busyMessage)}
            onClick={handleCaptureActiveTab}
            title="現在開いているタブの記事やタイムラインを未読キューに追加"
          >
            ＋ 今のタブ
          </button>
        </div>

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

        {(busyMessage || displayedEpisode?.statusDetail) && (
          <div className="status-banner" role="status">
            <span>{busyMessage || displayedEpisode?.statusDetail}</span>
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
                        : formatSec(displayedChapter?.durationSec || displayedEpisode.totalDurationSec)}
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
                disabled={queue.length === 0 || Boolean(busyMessage)}
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
                  未読キューは空です。X・Note・Zenn・Yahoo!・Google Newsを普段通り閲覧するか、「＋
                  今のタブ」「巡回して番組作成」を押すとここに記事が貯まります。
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
                    onChange={(e) => void handlePatchSettings({ geminiApiKey: e.target.value })}
                  />
                  <p className="field-hint">
                    ローカル（chrome.storage.local）にのみ保存されます。未入力時は音声が自動的にmacOS
                    Web Speechへフォールバックします。
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
