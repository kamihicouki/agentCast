import type {
  BuildMeta,
  ExtractedCandidate,
  ExtensionSettings,
  PlaybackState,
  PodcastEpisode,
  SourceId,
} from './types';

export interface ExtractionResultPayload {
  blocked: boolean;
  blockReason?: 'auth_required' | 'captcha_detected';
  blockMessage?: string;
  candidates: ExtractedCandidate[];
}

export type RuntimeRequest =
  | { type: 'CAPTURE_ACTIVE_TAB' }
  | { type: 'PATROL_SOURCES'; sources?: SourceId[] }
  | { type: 'PATROL_AND_GENERATE'; sources?: SourceId[] }
  | { type: 'GENERATE_EPISODE_FROM_QUEUE' }
  | { type: 'CREATE_DEMO_EPISODE' }
  | { type: 'PASSIVE_CANDIDATES'; candidates: ExtractedCandidate[]; pageUrl: string }
  | { type: 'CONTENT_EXTRACT_NOW'; scrollSteps?: number }
  | {
      type: 'WEB_LLM_PROMPT';
      provider: 'chatgpt' | 'gemini';
      prompt: string;
    }
  | { type: 'PLAY_EPISODE'; episodeId: string; chapterIndex?: number }
  | { type: 'TOGGLE_PLAY_PAUSE' }
  | { type: 'SKIP_CHAPTER'; delta: 1 | -1 }
  | { type: 'SEEK_RELATIVE'; deltaSec: number }
  | { type: 'SET_PLAYBACK_RATE'; rate: number }
  | { type: 'GET_PLAYBACK_STATE' }
  | { type: 'OFFSCREEN_PLAY_EPISODE'; episode: PodcastEpisode; chapterIndex: number; rate: number }
  | { type: 'OFFSCREEN_TOGGLE_PLAY_PAUSE' }
  | { type: 'OFFSCREEN_SKIP_CHAPTER'; delta: 1 | -1 }
  | { type: 'OFFSCREEN_SEEK_RELATIVE'; deltaSec: number }
  | { type: 'OFFSCREEN_SET_RATE'; rate: number }
  | { type: 'OFFSCREEN_GET_STATE' }
  | { type: 'OFFSCREEN_STATE_PUSH'; state: PlaybackState }
  | { type: 'TRIGGER_DEV_RELOAD_NOW' }
  | { type: 'GET_DEV_BUILD_STATUS' }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<ExtensionSettings> };

export interface DevBuildStatus {
  currentBuild: BuildMeta | null;
  pendingBuild: BuildMeta | null;
}
