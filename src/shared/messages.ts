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
  | { type: 'CAPTURE_AND_GENERATE_ACTIVE_TAB' }
  | { type: 'PATROL_SOURCES'; sources?: SourceId[] }
  | { type: 'PATROL_AND_GENERATE'; sources?: SourceId[] }
  | { type: 'LIST_TAB_GROUPS' }
  | { type: 'PATROL_TAB_GROUP'; groupId: number; generateAfter?: boolean }
  | { type: 'GENERATE_EPISODE_FROM_QUEUE' }
  | { type: 'DELETE_EPISODE'; episodeId: string }
  | { type: 'CLEANUP_STALE_EPISODES' }
  | { type: 'GET_JOB_STATUS' }
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
  | { type: 'UPDATE_SETTINGS'; settings: Partial<ExtensionSettings> }
  | { type: 'START_GEMINI_KEY_SETUP' }
  | { type: 'GEMINI_KEY_CAPTURED'; apiKey: string; closeSetupTab?: boolean }
  | { type: 'VERIFY_GEMINI_KEY'; apiKey?: string };

export interface DevBuildStatus {
  currentBuild: BuildMeta | null;
  pendingBuild: BuildMeta | null;
}
