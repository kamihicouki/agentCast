// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerPanel } from '../src/entrypoints/sidepanel/PlayerPanel';
import { SettingsPanel } from '../src/entrypoints/sidepanel/SettingsPanel';
import {
  APP_THEMES,
  DEFAULT_SETTINGS,
  INITIAL_PLAYBACK_STATE,
  type ExtensionSettings,
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

describe('One-click patrol-and-play UI', () => {
  it('invokes onPatrolAndPlay with a single click from PlayerPanel', () => {
    const onPatrolAndPlay = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        React.createElement(PlayerPanel, {
          episodes: [],
          displayedEpisode: null,
          displayedChapter: null,
          displayedChapterIndex: 0,
          isSelectedPlayingEpisode: false,
          playback: INITIAL_PLAYBACK_STATE,
          settings: DEFAULT_SETTINGS,
          isJobRunning: false,
          isResynthRunning: false,
          hasAudioExportable: false,
          isExporting: false,
          activeTurnRef: { current: null },
          formatSec: (s) => `${s}s`,
          formatEpisodeTimestamp: () => '',
          deriveEpisodeSubtitle: () => '',
          onSelectEpisode: vi.fn(),
          onPlayEpisode: vi.fn(),
          onTogglePlayPause: vi.fn(),
          onSkipChapter: vi.fn(),
          onSeekRelative: vi.fn(),
          onCycleSpeed: vi.fn(),
          onDeleteEpisode: vi.fn(),
          onResynthesizeEpisode: vi.fn().mockResolvedValue(undefined),
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
          enabledSourceCount: 5,
          isEngineReady: true,
          busyMessage: '',
          onPatrolAndPlay,
          onGoToSettings: vi.fn(),
        })
      );
    });

    const btn = container.querySelector<HTMLButtonElement>('#btn-one-click-patrol-play');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(false);
    expect(btn!.textContent).toContain('巡回して番組を作成・再生');

    act(() => {
      btn!.click();
    });

    expect(onPatrolAndPlay).toHaveBeenCalledTimes(1);
  });

  it('shows the 3-stage live pipeline progress while a job is running', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        React.createElement(PlayerPanel, {
          episodes: [],
          displayedEpisode: null,
          displayedChapter: null,
          displayedChapterIndex: 0,
          isSelectedPlayingEpisode: false,
          playback: INITIAL_PLAYBACK_STATE,
          settings: DEFAULT_SETTINGS,
          isJobRunning: true,
          isResynthRunning: false,
          hasAudioExportable: false,
          isExporting: false,
          activeTurnRef: { current: null },
          formatSec: (s) => `${s}s`,
          formatEpisodeTimestamp: () => '',
          deriveEpisodeSubtitle: () => '',
          onSelectEpisode: vi.fn(),
          onPlayEpisode: vi.fn(),
          onTogglePlayPause: vi.fn(),
          onSkipChapter: vi.fn(),
          onSeekRelative: vi.fn(),
          onCycleSpeed: vi.fn(),
          onDeleteEpisode: vi.fn(),
          onResynthesizeEpisode: vi.fn().mockResolvedValue(undefined),
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
          enabledSourceCount: 5,
          isEngineReady: true,
          busyMessage: '番組台本を構成中…',
          onPatrolAndPlay: vi.fn(),
          onGoToSettings: vi.fn(),
        })
      );
    });

    const steps = Array.from(container.querySelectorAll('.pipeline-step'));
    expect(steps).toHaveLength(3);
    expect(steps[0].classList.contains('is-done')).toBe(true);
    expect(steps[1].classList.contains('is-active')).toBe(true);
    expect(container.textContent).toContain('番組台本を構成中…');
  });
});

describe('Theme switcher in SettingsPanel', () => {
  it('renders all 4 themes and patches settings.theme when clicked', () => {
    const onPatchSettings = vi.fn().mockResolvedValue(undefined);
    const settings: ExtensionSettings = { ...DEFAULT_SETTINGS, theme: 'braun' };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        React.createElement(SettingsPanel, {
          settings,
          currentBuild: null,
          pendingBuild: null,
          isVerifyingKey: false,
          keyVerifyStatus: null,
          isVerifyingOpenAiKey: false,
          openAiKeyVerifyStatus: null,
          onPatchSettings,
          onStartGeminiKeySetup: vi.fn().mockResolvedValue(undefined),
          onVerifyGeminiKey: vi.fn().mockResolvedValue(undefined),
          onStartOpenAiKeySetup: vi.fn().mockResolvedValue(undefined),
          onVerifyOpenAiKey: vi.fn().mockResolvedValue(undefined),
          onCreateDemo: vi.fn().mockResolvedValue(undefined),
          onGoToPatrol: vi.fn(),
        })
      );
    });

    const themeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.theme-card'));
    expect(themeButtons).toHaveLength(APP_THEMES.length);
    expect(themeButtons[0].getAttribute('aria-checked')).toBe('true');

    const graphiteBtn = themeButtons.find((b) => b.textContent?.includes('Studio Dark'));
    expect(graphiteBtn).toBeDefined();

    act(() => {
      graphiteBtn!.click();
    });

    expect(onPatchSettings).toHaveBeenCalledWith({ theme: 'graphite' });
  });
});
