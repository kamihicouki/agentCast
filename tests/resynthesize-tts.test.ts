// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerPanel } from '../src/entrypoints/sidepanel/PlayerPanel';
import {
  DEFAULT_SETTINGS,
  INITIAL_PLAYBACK_STATE,
  type PodcastEpisode,
} from '../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

function makeEpisode(): PodcastEpisode {
  return {
    id: 'ep-1',
    createdAt: '2026-11-24T07:31:00.000Z',
    updatedAt: '2026-11-24T07:31:00.000Z',
    title: 'テスト番組',
    subtitle: 'サブタイトル',
    status: 'ready',
    totalDurationSec: 120,
    providerLabel: 'Gemini Pro/Ultra (Web)',
    ttsEngineLabel: 'OpenAI TTS (tts-1)',
    sourceCount: 1,
    chapters: [
      {
        id: 'ch-0',
        index: 0,
        title: 'オープニング',
        summary: 'テスト要約',
        durationSec: 120,
        hasAudioBlob: true,
        sourceItems: [],
        turns: [
          { id: 't1', speaker: 'HostA', speakerName: 'カイ', text: 'おはようございます。' },
          { id: 't2', speaker: 'HostB', speakerName: 'ミオ', text: 'こんにちは。' },
        ],
      },
    ],
  };
}

function renderPlayerPanel(opts: {
  isJobRunning: boolean;
  isResynthRunning: boolean;
  onResynthesizeEpisode?: ReturnType<typeof vi.fn>;
}) {
  const episode = makeEpisode();
  const onResynthesizeEpisode = opts.onResynthesizeEpisode ?? vi.fn().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root!.render(
      React.createElement(PlayerPanel, {
        episodes: [episode],
        displayedEpisode: episode,
        displayedChapter: episode.chapters[0],
        displayedChapterIndex: 0,
        isSelectedPlayingEpisode: true,
        playback: { ...INITIAL_PLAYBACK_STATE, episodeId: episode.id, isPlaying: true },
        settings: {
          ...DEFAULT_SETTINGS,
          ttsMode: 'gemini_tts',
          geminiApiKey: 'test-gemini-key',
          openaiApiKey: 'test-openai-key',
        },
        isJobRunning: opts.isJobRunning,
        isResynthRunning: opts.isResynthRunning,
        hasAudioExportable: true,
        isExporting: false,
        activeTurnRef: { current: null },
        formatSec: (s) => `${s}s`,
        formatEpisodeTimestamp: () => '2026/11/24 07:31',
        deriveEpisodeSubtitle: (ep) => ep.subtitle,
        onSelectEpisode: vi.fn(),
        onPlayEpisode: vi.fn(),
        onTogglePlayPause: vi.fn(),
        onSkipChapter: vi.fn(),
        onSeekRelative: vi.fn(),
        onCycleSpeed: vi.fn(),
        onDeleteEpisode: vi.fn(),
        onResynthesizeEpisode,
        onStartGeminiKeySetup: vi.fn().mockResolvedValue(undefined),
        onStartOpenAiKeySetup: vi.fn().mockResolvedValue(undefined),
        onDownloadAudio: vi.fn(),
        onDownloadHtml: vi.fn(),
        onCopyMarkdown: vi.fn(),
        onShareNative: vi.fn(),
        onPublishYouTube: vi.fn(),
        onPublishX: vi.fn(),
        onDownloadMp4: vi.fn(),
        onCreateDemo: vi.fn(),
        onGoToPatrol: vi.fn(),
      })
    );
  });

  return { container: container!, onResynthesizeEpisode };
}

describe('PlayerPanel TTS resynthesis independence', () => {
  it('allows opening and submitting 別TTSで再合成 while another patrol/script job is running', () => {
    const { container: host, onResynthesizeEpisode } = renderPlayerPanel({
      isJobRunning: true,
      isResynthRunning: false,
    });

    const toggleBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('別TTSで再合成')
    );
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn!.disabled).toBe(false);

    act(() => {
      toggleBtn!.click();
    });

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('この台本で音声を再作成')
    );
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.disabled).toBe(false);

    act(() => {
      submitBtn!.click();
    });

    expect(onResynthesizeEpisode).toHaveBeenCalledTimes(1);
    expect(onResynthesizeEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        episodeId: 'ep-1',
        ttsMode: 'gemini_tts',
        mode: 'duplicate',
      })
    );
  });

  it('disables only the resynthesize submit button when another resynthesis is already in progress', () => {
    const { container: host } = renderPlayerPanel({
      isJobRunning: false,
      isResynthRunning: true,
    });

    const toggleBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('再合成中')
    );
    expect(toggleBtn).toBeDefined();
    expect(toggleBtn!.disabled).toBe(false);

    act(() => {
      toggleBtn!.click();
    });

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('音声を再合成中')
    );
    expect(submitBtn).toBeDefined();
    expect(submitBtn!.disabled).toBe(true);
  });
});
