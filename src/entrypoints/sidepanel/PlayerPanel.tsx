import React, { useEffect, useMemo, useState } from 'react';
import {
  GEMINI_TTS_MODELS,
  GEMINI_VOICES,
  OPENAI_TTS_MODELS,
  SOURCE_META,
  type EpisodeChapter,
  type ExtensionSettings,
  type PlaybackState,
  type PodcastEpisode,
  type TTSMode,
} from '../../shared/types';

export interface ResynthesizeRequest {
  episodeId: string;
  ttsMode: TTSMode;
  geminiTtsModel?: string;
  openaiTtsModel?: string;
  hostAVoice?: string;
  hostBVoice?: string;
  mode: 'duplicate' | 'overwrite';
}

interface PlayerPanelProps {
  episodes: PodcastEpisode[];
  displayedEpisode: PodcastEpisode | null;
  displayedChapter: EpisodeChapter | null;
  displayedChapterIndex: number;
  isSelectedPlayingEpisode: boolean;
  playback: PlaybackState;
  settings: ExtensionSettings;
  isJobRunning: boolean;
  isResynthRunning: boolean;
  hasAudioExportable: boolean;
  isExporting: boolean;
  activeTurnRef: React.RefObject<HTMLDivElement | null>;
  formatSec: (sec: number) => string;
  formatEpisodeTimestamp: (iso?: string) => string;
  deriveEpisodeSubtitle: (ep: PodcastEpisode) => string;
  onSelectEpisode: (epId: string) => void;
  onPlayEpisode: (epId: string, chapterIndex?: number) => void;
  onTogglePlayPause: () => void;
  onSkipChapter: (delta: 1 | -1) => void;
  onSeekRelative: (deltaSec: number) => void;
  onCycleSpeed: () => void;
  onDeleteEpisode: (epId: string) => void;
  onResynthesizeEpisode: (req: ResynthesizeRequest) => Promise<void>;
  onStartGeminiKeySetup: () => Promise<void>;
  onStartOpenAiKeySetup: () => Promise<void>;
  onDownloadAudio: () => void;
  onDownloadHtml: () => void;
  onCopyMarkdown: () => void;
  onShareNative: () => void;
  onPublishYouTube: () => void;
  onPublishX: () => void;
  onDownloadMp4: () => void;
  onCreateDemo: () => void;
  onGoToPatrol: () => void;
  // Optional one-click broadcast unit props
  enabledSourceCount?: number;
  isEngineReady?: boolean;
  busyMessage?: string;
  onPatrolAndPlay?: () => void;
  onGoToSettings?: () => void;
}

function inferPipelineStage(
  isJobRunning: boolean,
  busyMessage: string,
  episode: PodcastEpisode | null,
  isPlaying: boolean
): 0 | 1 | 2 | 3 {
  if (!isJobRunning) return isPlaying ? 3 : 0;
  const msg = `${busyMessage} ${episode?.statusDetail || ''}`;
  if (
    episode?.status === 'generating_script' ||
    episode?.status === 'synthesizing_audio' ||
    /台本|構成|音声|合成|TTS|チャプター/.test(msg)
  ) {
    return 2;
  }
  if (isPlaying && episode?.status === 'ready') {
    return 3;
  }
  return 1;
}

export function PlayerPanel({
  episodes,
  displayedEpisode,
  displayedChapter,
  displayedChapterIndex,
  isSelectedPlayingEpisode,
  playback,
  settings,
  isJobRunning,
  isResynthRunning,
  hasAudioExportable,
  isExporting,
  activeTurnRef,
  formatSec,
  formatEpisodeTimestamp,
  deriveEpisodeSubtitle,
  onSelectEpisode,
  onPlayEpisode,
  onTogglePlayPause,
  onSkipChapter,
  onSeekRelative,
  onCycleSpeed,
  onDeleteEpisode,
  onResynthesizeEpisode,
  onStartGeminiKeySetup,
  onStartOpenAiKeySetup,
  onDownloadAudio,
  onDownloadHtml,
  onCopyMarkdown,
  onShareNative,
  onPublishYouTube,
  onPublishX,
  onDownloadMp4,
  onCreateDemo,
  onGoToPatrol,
  enabledSourceCount,
  isEngineReady = true,
  busyMessage = '',
  onPatrolAndPlay,
  onGoToSettings,
}: PlayerPanelProps) {
  const [subTab, setSubTab] = useState<'script' | 'library'>('script');
  const [search, setSearch] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [showResynth, setShowResynth] = useState(false);
  const [resynthTtsMode, setResynthTtsMode] = useState<TTSMode>(settings.ttsMode);
  const [resynthGeminiModel, setResynthGeminiModel] = useState<string>(
    settings.geminiTtsModel || 'gemini-3.8-flash-tts'
  );
  const [resynthOpenAiModel, setResynthOpenAiModel] = useState<string>(
    settings.openaiTtsModel || 'tts-1'
  );
  const [resynthHostAVoice, setResynthHostAVoice] = useState<string>(settings.hostAVoice || 'Puck');
  const [resynthHostBVoice, setResynthHostBVoice] = useState<string>(settings.hostBVoice || 'Aoede');
  const [resynthDuplicate, setResynthDuplicate] = useState<boolean>(true);

  useEffect(() => {
    setResynthTtsMode(settings.ttsMode);
    setResynthGeminiModel(settings.geminiTtsModel || 'gemini-3.8-flash-tts');
    setResynthOpenAiModel(settings.openaiTtsModel || 'tts-1');
    setResynthHostAVoice(settings.hostAVoice || 'Puck');
    setResynthHostBVoice(settings.hostBVoice || 'Aoede');
  }, [
    settings.ttsMode,
    settings.geminiTtsModel,
    settings.openaiTtsModel,
    settings.hostAVoice,
    settings.hostBVoice,
  ]);

  const missingResynthKey =
    (resynthTtsMode === 'gemini_tts' && !settings.geminiApiKey.trim()) ||
    (resynthTtsMode === 'openai_tts' && !settings.openaiApiKey.trim());

  const filteredEpisodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return episodes;
    return episodes.filter((ep) => {
      const sub = deriveEpisodeSubtitle(ep);
      return (
        ep.title.toLowerCase().includes(q) ||
        sub.toLowerCase().includes(q) ||
        ep.chapters.some((c) => c.title.toLowerCase().includes(q))
      );
    });
  }, [episodes, search, deriveEpisodeSubtitle]);

  const isPlayingNow = Boolean(isSelectedPlayingEpisode && playback.isPlaying);
  const currentSec = isSelectedPlayingEpisode ? playback.currentTimeSec : 0;
  const chapterDurationSec = isSelectedPlayingEpisode
    ? playback.durationSec || displayedChapter?.durationSec || 0
    : displayedChapter?.durationSec || 0;
  const progressPct =
    chapterDurationSec > 0 ? Math.min(100, Math.max(0, (currentSec / chapterDurationSec) * 100)) : 0;

  const durationLabel =
    settings.durationMode === 'auto' ? 'おまかせ尺' : `${settings.targetDurationMin || 10}分`;
  const pipelineStage = inferPipelineStage(isJobRunning, busyMessage, displayedEpisode, isPlayingNow);

  return (
    <section className="step-section" aria-label="聴く・ワンクリック番組作成">
      {/* ==================== ONE-CLICK BROADCAST UNIT ==================== */}
      {onPatrolAndPlay && (
        <div className="broadcast-unit" aria-label="ワンクリック番組作成と再生">
          {!isEngineReady && onGoToSettings && (
            <div className="broadcast-setup-notice">
              <span>AI・音声エンジンの初期設定が必要です</span>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={onGoToSettings}
              >
                設定を開く
              </button>
            </div>
          )}

          <button
            id="btn-one-click-patrol-play"
            type="button"
            className="btn-broadcast"
            disabled={isJobRunning || enabledSourceCount === 0}
            onClick={onPatrolAndPlay}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              {isJobRunning ? (
                <circle
                  cx="8"
                  cy="8"
                  r="5.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeDasharray="22 12"
                />
              ) : (
                <path d="M4.5 3.2L12.8 8L4.5 12.8V3.2Z" fill="currentColor" />
              )}
            </svg>
            <span>
              {isJobRunning
                ? '巡回・番組を作成中…'
                : enabledSourceCount === 0
                  ? '巡回ソースを1つ以上有効にしてください'
                  : '巡回して番組を作成・再生'}
            </span>
          </button>

          <div className="broadcast-meta-row">
            <span className="broadcast-meta-specs">
              {typeof enabledSourceCount === 'number' ? `${enabledSourceCount} ソース` : ''}
              {' · '}
              {durationLabel}
              {' · 自動再生'}
            </span>
            <button type="button" className="btn-ghost" onClick={onGoToPatrol}>
              ソースを変更
            </button>
          </div>

          {isJobRunning && (
            <>
              <div className="pipeline-track" aria-label="進行状況">
                <div
                  className={`pipeline-step ${
                    pipelineStage === 1 ? 'is-active' : pipelineStage > 1 ? 'is-done' : ''
                  }`}
                >
                  <span className="pipeline-step-num">01</span>
                  <span>巡回</span>
                </div>
                <div
                  className={`pipeline-step ${
                    pipelineStage === 2 ? 'is-active' : pipelineStage > 2 ? 'is-done' : ''
                  }`}
                >
                  <span className="pipeline-step-num">02</span>
                  <span>番組作成</span>
                </div>
                <div className={`pipeline-step ${pipelineStage === 3 ? 'is-active' : ''}`}>
                  <span className="pipeline-step-num">03</span>
                  <span>再生</span>
                </div>
              </div>
              {busyMessage && <p className="pipeline-live-msg">{busyMessage}</p>}
            </>
          )}
        </div>
      )}

      {/* ==================== EMPTY STATE ==================== */}
      {episodes.length === 0 && (
        <div className="empty-box">
          <p>
            まだ番組がありません。上のボタンで巡回から再生まで一括実行するか、デモ番組を試聴できます。
          </p>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 8 }}>
            <button type="button" className="btn-secondary" onClick={onCreateDemo}>
              デモ番組を試聴
            </button>
            <button type="button" className="btn-ghost" onClick={onGoToPatrol}>
              巡回ソースを見る
            </button>
          </div>
        </div>
      )}

      {/* ==================== NOW PLAYING HARDWARE DECK ==================== */}
      {displayedEpisode && (
        <div className="player-deck" aria-label="再生デッキ">
          <div className="deck-status-row">
            <span className="deck-led-group">
              <span className={`deck-led ${isPlayingNow ? 'is-live' : ''}`} aria-hidden="true" />
              {isPlayingNow
                ? 'ON AIR'
                : displayedEpisode.status === 'ready'
                  ? 'READY'
                  : 'PREPARING'}
            </span>
            <span className="deck-timestamp">
              {formatEpisodeTimestamp(displayedEpisode.createdAt)} ·{' '}
              {formatSec(displayedEpisode.totalDurationSec)}
              {displayedEpisode.ttsEngineLabel ? ` · ${displayedEpisode.ttsEngineLabel}` : ''}
            </span>
          </div>

          <div>
            <h2 className="deck-title">{displayedEpisode.title}</h2>
            <p className="deck-subtitle">{deriveEpisodeSubtitle(displayedEpisode)}</p>
          </div>

          {displayedChapter && (
            <div className="deck-progress-block">
              <div className="deck-progress-rail" aria-hidden="true">
                <div className="deck-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="deck-progress-meta">
                <span className="mono-time">{formatSec(currentSec)}</span>
                <span className="deck-chapter-label">
                  {displayedChapterIndex + 1}/{displayedEpisode.chapters.length} ·{' '}
                  {displayedChapter.title}
                </span>
                <span className="mono-time">{formatSec(chapterDurationSec)}</span>
              </div>
            </div>
          )}

          {/* Tactile Transport Row */}
          <div className="transport-row">
            <button
              type="button"
              className="transport-btn"
              onClick={() => onSeekRelative(-15)}
              title="15秒戻る"
            >
              -15s
            </button>
            <button
              type="button"
              className="transport-btn"
              onClick={() => onSkipChapter(-1)}
              title="前のチャプター"
              aria-label="前のチャプター"
            >
              ⏮
            </button>
            <button
              id="btn-play-toggle"
              type="button"
              className={`btn-play-hero ${isPlayingNow ? 'is-playing' : ''}`}
              disabled={displayedEpisode.chapters.length === 0}
              onClick={() => {
                if (isSelectedPlayingEpisode) onTogglePlayPause();
                else onPlayEpisode(displayedEpisode.id, displayedChapterIndex);
              }}
            >
              {isPlayingNow ? '一時停止' : '再生'}
            </button>
            <button
              type="button"
              className="transport-btn"
              onClick={() => onSkipChapter(1)}
              title="次のチャプター"
              aria-label="次のチャプター"
            >
              ⏭
            </button>
            <button
              type="button"
              className="transport-btn"
              onClick={() => onSeekRelative(30)}
              title="30秒進む"
            >
              +30s
            </button>
            <button
              type="button"
              className="transport-btn"
              onClick={onCycleSpeed}
              title="再生速度を切替"
            >
              {playback.playbackRate.toFixed(2).replace(/\.00$/, '.0')}x
            </button>
          </div>

          {/* Quiet Secondary Controls (Progressive Disclosure) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              paddingTop: 8,
              borderTop: '1px solid var(--line-subtle)',
            }}
          >
            <button
              type="button"
              className={`btn-secondary btn-compact ${showResynth ? 'is-active' : ''}`}
              disabled={displayedEpisode.chapters.length === 0}
              onClick={() => {
                setShowResynth((v) => !v);
                setShowExport(false);
              }}
              title="同じ台本を使って別のTTS・モデルで音声を再作成"
            >
              {isResynthRunning ? '再合成中…' : '別TTSで再合成'}
            </button>

            <button
              type="button"
              className={`btn-secondary btn-compact ${showExport ? 'is-active' : ''}`}
              onClick={() => {
                setShowExport((v) => !v);
                setShowResynth(false);
              }}
            >
              {showExport ? '書き出しを閉じる' : '書き出し・公開'}
            </button>
          </div>

          {/* Export / Publish Drawer */}
          {showExport && (
            <div className="output-grid" aria-label="書き出し・公開">
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || !hasAudioExportable}
                onClick={onDownloadAudio}
              >
                音声保存 (WAV)
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting}
                onClick={onDownloadHtml}
              >
                ポータブル HTML
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={onCopyMarkdown}
              >
                台本コピー (MD)
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting}
                onClick={onShareNative}
              >
                共有
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || !hasAudioExportable}
                onClick={onDownloadMp4}
              >
                動画保存 (MP4)
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || displayedEpisode.status !== 'ready'}
                onClick={onPublishYouTube}
              >
                YouTube 公開
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || displayedEpisode.status !== 'ready'}
                onClick={onPublishX}
                style={{ gridColumn: '1 / -1' }}
              >
                X に投稿
              </button>
            </div>
          )}

          {/* Resynthesize Drawer */}
          {showResynth && (
            <div
              className="n-card"
              style={{ padding: 12, background: 'var(--bg-surface-subtle)' }}
              aria-label="同じ台本で別TTS・モデル再合成"
            >
              <div className="card-head-row" style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 12 }}>同じ台本で別モデル / TTS 再作成</strong>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setShowResynth(false)}
                  aria-label="再合成パネルを閉じる"
                >
                  ✕
                </button>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="resynth-tts-mode">
                  音声合成エンジン (TTS)
                </label>
                <select
                  id="resynth-tts-mode"
                  className="field-select"
                  value={resynthTtsMode}
                  onChange={(e) => setResynthTtsMode(e.target.value as TTSMode)}
                >
                  <option value="gemini_tts">Gemini Multi-Speaker TTS（自然な2人掛け合い）</option>
                  <option value="openai_tts">OpenAI TTS（話者別MP3合成）</option>
                  <option value="macos_speech">macOS Web Speech（無料・ローカル日本語）</option>
                </select>
              </div>

              {resynthTtsMode === 'gemini_tts' && (
                <>
                  <div className="field-row">
                    <label className="field-label" htmlFor="resynth-gemini-model">
                      Gemini TTS モデル
                    </label>
                    <select
                      id="resynth-gemini-model"
                      className="field-select"
                      value={resynthGeminiModel}
                      onChange={(e) => setResynthGeminiModel(e.target.value)}
                    >
                      {GEMINI_TTS_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid-2">
                    <div className="field-row">
                      <label className="field-label" htmlFor="resynth-host-a-voice">
                        Host A 声色
                      </label>
                      <select
                        id="resynth-host-a-voice"
                        className="field-select"
                        value={resynthHostAVoice}
                        onChange={(e) => setResynthHostAVoice(e.target.value)}
                      >
                        {GEMINI_VOICES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field-row">
                      <label className="field-label" htmlFor="resynth-host-b-voice">
                        Host B 声色
                      </label>
                      <select
                        id="resynth-host-b-voice"
                        className="field-select"
                        value={resynthHostBVoice}
                        onChange={(e) => setResynthHostBVoice(e.target.value)}
                      >
                        {GEMINI_VOICES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}

              {resynthTtsMode === 'openai_tts' && (
                <div className="field-row">
                  <label className="field-label" htmlFor="resynth-openai-model">
                    OpenAI TTS モデル
                  </label>
                  <select
                    id="resynth-openai-model"
                    className="field-select"
                    value={resynthOpenAiModel}
                    onChange={(e) => setResynthOpenAiModel(e.target.value)}
                  >
                    {OPENAI_TTS_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="toggle-row" style={{ marginTop: 4 }}>
                <span>元の音声を残して別エピソードとして作成</span>
                <input
                  type="checkbox"
                  checked={resynthDuplicate}
                  onChange={(e) => setResynthDuplicate(e.target.checked)}
                />
              </div>

              {missingResynthKey ? (
                <div style={{ marginTop: 8 }}>
                  <p className="field-hint" style={{ marginBottom: 6 }}>
                    {resynthTtsMode === 'openai_tts'
                      ? 'OpenAI API Key が未設定です。'
                      : 'Gemini API Key が未設定です。'}
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ width: '100%' }}
                    onClick={() =>
                      void (resynthTtsMode === 'openai_tts'
                        ? onStartOpenAiKeySetup()
                        : onStartGeminiKeySetup())
                    }
                  >
                    {resynthTtsMode === 'openai_tts'
                      ? 'OpenAI でワンクリック連携'
                      : 'AI Studio でワンクリック連携'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn-primary"
                  style={{ width: '100%', marginTop: 8 }}
                  disabled={isResynthRunning}
                  onClick={() => {
                    setShowResynth(false);
                    void onResynthesizeEpisode({
                      episodeId: displayedEpisode.id,
                      ttsMode: resynthTtsMode,
                      geminiTtsModel: resynthGeminiModel,
                      openaiTtsModel: resynthOpenAiModel,
                      hostAVoice: resynthHostAVoice,
                      hostBVoice: resynthHostBVoice,
                      mode: resynthDuplicate ? 'duplicate' : 'overwrite',
                    });
                  }}
                >
                  {isResynthRunning ? '音声を再合成中…' : 'この台本で音声を再作成'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ==================== EDITORIAL SUB-TABS: SCRIPT / LIBRARY ==================== */}
      {episodes.length > 0 && (
        <>
          <div className="sub-tabs" role="tablist" aria-label="表示切替">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'script'}
              className={`sub-tab ${subTab === 'script' ? 'is-active' : ''}`}
              onClick={() => setSubTab('script')}
            >
              台本・チャプター
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'library'}
              className={`sub-tab ${subTab === 'library' ? 'is-active' : ''}`}
              onClick={() => setSubTab('library')}
            >
              番組一覧 ({episodes.length})
            </button>
          </div>

          {subTab === 'script' && displayedEpisode && displayedEpisode.chapters.length > 0 && (
            <div className="n-card script-panel">
              <div className="chapter-pills" role="tablist" aria-label="チャプター一覧">
                {displayedEpisode.chapters.map((ch, idx) => (
                  <button
                    key={ch.id}
                    type="button"
                    className={`chapter-pill ${idx === displayedChapterIndex ? 'is-active' : ''}`}
                    onClick={() => onPlayEpisode(displayedEpisode.id, idx)}
                  >
                    {idx + 1}. {ch.title}
                  </button>
                ))}
              </div>

              {displayedChapter && (
                <>
                  {displayedChapter.summary && (
                    <p className="chapter-summary">{displayedChapter.summary}</p>
                  )}

                  {displayedChapter.sourceItems.length > 0 && (
                    <div className="source-chips">
                      {displayedChapter.sourceItems.map((ref) => (
                        <a
                          key={ref.id}
                          href={ref.url}
                          target="_blank"
                          rel="noreferrer"
                          className="source-chip"
                        >
                          {SOURCE_META[ref.source]?.shortLabel || ref.source} ·{' '}
                          {ref.title.slice(0, 32)}
                        </a>
                      ))}
                    </div>
                  )}

                  <div className="dialogue-list">
                    {displayedChapter.turns.map((turn, tIdx) => {
                      const isActive =
                        isSelectedPlayingEpisode &&
                        playback.chapterIndex === displayedChapterIndex &&
                        playback.turnIndex === tIdx;
                      return (
                        <div
                          key={turn.id}
                          ref={isActive ? activeTurnRef : null}
                          className={`dialogue-turn ${isActive ? 'is-active' : ''} speaker-${turn.speaker.toLowerCase()}`}
                        >
                          <span className="turn-speaker">{turn.speakerName}</span>
                          <p className="turn-text">{turn.text}</p>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {subTab === 'library' && (
            <div className="library-view">
              <input
                type="search"
                className="field-input"
                placeholder="過去の番組やトピックを検索…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="番組を検索"
              />

              <div className="library-list">
                {filteredEpisodes.map((ep) => {
                  const isCurrent = playback.episodeId === ep.id;
                  const isEpPlaying = isCurrent && playback.isPlaying;
                  const sub = deriveEpisodeSubtitle(ep);

                  return (
                    <article
                      key={ep.id}
                      className={`library-card ${isCurrent ? 'is-current' : ''}`}
                    >
                      <button
                        type="button"
                        className="library-play-btn"
                        onClick={() => {
                          onSelectEpisode(ep.id);
                          if (isCurrent) {
                            onTogglePlayPause();
                          } else {
                            onPlayEpisode(ep.id, 0);
                          }
                          setSubTab('script');
                        }}
                        title={isEpPlaying ? '一時停止' : '再生'}
                        aria-label={`${ep.title} を再生`}
                      >
                        {isEpPlaying ? (
                          <div className="eq-bars" aria-hidden="true">
                            <span className="eq-bar" />
                            <span className="eq-bar" />
                            <span className="eq-bar" />
                          </div>
                        ) : (
                          <span>▶</span>
                        )}
                      </button>

                      <button
                        type="button"
                        className="library-info"
                        onClick={() => {
                          onSelectEpisode(ep.id);
                          setSubTab('script');
                        }}
                      >
                        <div className="library-meta">
                          <span className={isCurrent ? 'is-accent' : ''}>
                            {formatEpisodeTimestamp(ep.createdAt)}
                          </span>
                          <span>
                            {ep.status === 'ready'
                              ? formatSec(ep.totalDurationSec)
                              : ep.statusDetail || '生成中…'}
                          </span>
                        </div>
                        <h3 className="library-title">{ep.title}</h3>
                        <p className="library-sub">{sub}</p>
                      </button>

                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={(isJobRunning || isResynthRunning) && ep.status !== 'ready'}
                        onClick={() => onDeleteEpisode(ep.id)}
                        title="この番組を削除"
                        aria-label={`${ep.title} を削除`}
                      >
                        ✕
                      </button>
                    </article>
                  );
                })}
                {filteredEpisodes.length === 0 && (
                  <p className="field-hint" style={{ padding: 12 }}>
                    「{search}」に一致する番組がありません。
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
