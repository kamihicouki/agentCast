import React, { useMemo, useState } from 'react';
import {
  SOURCE_META,
  type EpisodeChapter,
  type PlaybackState,
  type PodcastEpisode,
} from '../../shared/types';

interface PlayerPanelProps {
  episodes: PodcastEpisode[];
  displayedEpisode: PodcastEpisode | null;
  displayedChapter: EpisodeChapter | null;
  displayedChapterIndex: number;
  isSelectedPlayingEpisode: boolean;
  playback: PlaybackState;
  isJobRunning: boolean;
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
  onDownloadAudio: () => void;
  onDownloadHtml: () => void;
  onCopyMarkdown: () => void;
  onShareNative: () => void;
  onPublishYouTube: () => void;
  onPublishX: () => void;
  onDownloadMp4: () => void;
  onCreateDemo: () => void;
  onGoToPatrol: () => void;
}

const COVER_VARIANTS = ['n-cover-0', 'n-cover-1', 'n-cover-2', 'n-cover-3'];

export function PlayerPanel({
  episodes,
  displayedEpisode,
  displayedChapter,
  displayedChapterIndex,
  isSelectedPlayingEpisode,
  playback,
  isJobRunning,
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
  onDownloadAudio,
  onDownloadHtml,
  onCopyMarkdown,
  onShareNative,
  onPublishYouTube,
  onPublishX,
  onDownloadMp4,
  onCreateDemo,
  onGoToPatrol,
}: PlayerPanelProps) {
  // Default to Now Playing when actively playing, otherwise Library is 1 tap away (or default if idle)
  const [view, setView] = useState<'now' | 'library'>(() =>
    playback.isPlaying ? 'now' : 'library'
  );
  const [search, setSearch] = useState('');

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

  const effectiveView: 'now' | 'library' =
    displayedEpisode && view === 'now' ? 'now' : episodes.length === 0 ? 'now' : view;

  const isPlayingNow = Boolean(isSelectedPlayingEpisode && playback.isPlaying);
  const coverClass =
    COVER_VARIANTS[
      Math.max(0, episodes.findIndex((e) => e.id === displayedEpisode?.id)) % COVER_VARIANTS.length
    ];

  return (
    <section className="step-section" aria-label="STEP 4 番組ライブラリと再生">
      {/* [1] Step Header + View Switch */}
      <div className="step-header">
        <div>
          <div className="step-kicker">STEP 4 / LIBRARY &amp; PLAYER</div>
          <h2 className="step-title">番組ライブラリ・再生</h2>
        </div>
        <div className="segmented segmented-2" role="tablist" aria-label="表示切替">
          <button
            type="button"
            className={`segment ${effectiveView === 'now' ? 'is-active' : ''}`}
            onClick={() => setView('now')}
          >
            再生中
          </button>
          <button
            type="button"
            className={`segment ${effectiveView === 'library' ? 'is-active' : ''}`}
            onClick={() => setView('library')}
          >
            ライブラリ ({episodes.length})
          </button>
        </div>
      </div>

      {/* Empty State */}
      {episodes.length === 0 && (
        <div className="empty-box">
          <p>まだ番組がありません。巡回して最新ニュースから番組を作成するか、デモ番組を試聴できます。</p>
          <div className="action-row-2" style={{ marginTop: 12 }}>
            <button type="button" className="btn-primary" onClick={onGoToPatrol}>
              ← STEP 2 巡回へ
            </button>
            <button type="button" className="btn-secondary" onClick={onCreateDemo}>
              デモ番組を試聴
            </button>
          </div>
        </div>
      )}

      {/* ==================== LIBRARY VIEW (Spotify / Apple Music style) ==================== */}
      {episodes.length > 0 && effectiveView === 'library' && (
        <div className="library-view">
          <input
            type="search"
            className="field-input"
            placeholder="🔍 過去の番組・トピックを検索…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="番組を検索"
          />

          <div className="library-list">
            {filteredEpisodes.map((ep, idx) => {
              const isCurrent = playback.episodeId === ep.id;
              const isEpPlaying = isCurrent && playback.isPlaying;
              const variant = COVER_VARIANTS[idx % COVER_VARIANTS.length];
              const sub = deriveEpisodeSubtitle(ep);

              return (
                <article
                  key={ep.id}
                  className={`library-card ${isCurrent ? 'is-current' : ''}`}
                >
                  <button
                    type="button"
                    className={`library-cover ${variant}`}
                    onClick={() => {
                      onSelectEpisode(ep.id);
                      if (isCurrent) {
                        onTogglePlayPause();
                      } else {
                        onPlayEpisode(ep.id, 0);
                      }
                      setView('now');
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
                      setView('now');
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
                    disabled={isJobRunning && ep.status !== 'ready'}
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
              <p className="field-hint">「{search}」に一致する番組がありません。</p>
            )}
          </div>
        </div>
      )}

      {/* ==================== NOW PLAYING VIEW (Napster Deck + Dynamic Script) ==================== */}
      {displayedEpisode && effectiveView === 'now' && (
        <>
          <div className="n-primary-card now-playing-deck">
            <div className="np-hero">
              <div className={`np-cover ${coverClass}`} aria-hidden="true">
                <div className={`eq-bars ${isPlayingNow ? '' : 'is-paused'}`}>
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                  <span className="eq-bar" />
                </div>
                <span className="np-cover-label">{isPlayingNow ? 'ON AIR' : 'READY'}</span>
              </div>
              <div className="np-meta">
                <div className="np-timestamp">
                  {formatEpisodeTimestamp(displayedEpisode.createdAt)} ・{' '}
                  {formatSec(displayedEpisode.totalDurationSec)}
                </div>
                <h3 className="np-title">{displayedEpisode.title}</h3>
                <p className="np-subtitle">{deriveEpisodeSubtitle(displayedEpisode)}</p>
              </div>
            </div>

            {/* Scrubber & Time */}
            {displayedChapter && (
              <div className="np-progress-row">
                <span className="mono-time">
                  {formatSec(isSelectedPlayingEpisode ? playback.currentTimeSec : 0)}
                </span>
                <span className="np-chapter-indicator">
                  Ch {displayedChapterIndex + 1}/{displayedEpisode.chapters.length}:{' '}
                  {displayedChapter.title}
                </span>
                <span className="mono-time">
                  {formatSec(
                    isSelectedPlayingEpisode
                      ? playback.durationSec || displayedChapter.durationSec
                      : displayedChapter.durationSec
                  )}
                </span>
              </div>
            )}

            {/* Transport Controls */}
            <div className="transport-row">
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={() => onSeekRelative(-15)}
                title="15秒戻る"
              >
                -15s
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={() => onSkipChapter(-1)}
                title="前のチャプター"
              >
                ⏮
              </button>
              <button
                id="btn-play-toggle"
                type="button"
                className="btn-primary btn-play-hero"
                disabled={displayedEpisode.chapters.length === 0}
                onClick={() => {
                  if (isSelectedPlayingEpisode) onTogglePlayPause();
                  else onPlayEpisode(displayedEpisode.id, displayedChapterIndex);
                }}
              >
                {isPlayingNow ? '⏸ 一時停止' : '▶ 再生'}
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={() => onSkipChapter(1)}
                title="次のチャプター"
              >
                ⏭
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={() => onSeekRelative(30)}
                title="30秒進む"
              >
                +30s
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={onCycleSpeed}
                title="再生速度を切替"
              >
                {playback.playbackRate.toFixed(2).replace(/\.00$/, '.0')}x
              </button>
            </div>

            {/* Export & Publish Strip */}
            <div className="np-actions-strip">
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || !hasAudioExportable}
                onClick={onDownloadAudio}
                title="音声ファイル (WAV) を保存"
              >
                💾 音声
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting}
                onClick={onDownloadHtml}
                title="再生可能なHTMLとして保存"
              >
                📦 HTML
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={onCopyMarkdown}
                title="台本をMarkdownでコピー"
              >
                📋 台本
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting}
                onClick={onShareNative}
              >
                🔗 共有
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || displayedEpisode.status !== 'ready'}
                onClick={onPublishYouTube}
              >
                📺 YouTube公開
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || displayedEpisode.status !== 'ready'}
                onClick={onPublishX}
              >
                𝕏 X投稿
              </button>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={isExporting || !hasAudioExportable}
                onClick={onDownloadMp4}
              >
                🎬 MP4
              </button>
            </div>
          </div>

          {/* Chapter Pills & Dynamic Lyrics-style Script */}
          {displayedEpisode.chapters.length > 0 && (
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
                          [{SOURCE_META[ref.source]?.shortLabel || ref.source}] {ref.title.slice(0, 32)}
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
        </>
      )}
    </section>
  );
}
