import type {
  BuildMeta,
  ExtractedCandidate,
  ExtensionSettings,
  ExtractionStrategy,
  PlaybackState,
  PodcastEpisode,
  SourceId,
} from './types';

export interface CustomExtractRule {
  strategy: ExtractionStrategy;
  cssSelector?: string;
  siteName?: string;
}

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
  | { type: 'PATROL_CUSTOM_SITE'; siteId: string; generateAfter?: boolean }
  | { type: 'LIST_TAB_GROUPS' }
  | { type: 'PATROL_TAB_GROUP'; groupId: number; generateAfter?: boolean }
  | {
      type: 'GENERATE_EPISODE_FROM_QUEUE';
      itemIds?: string[];
      durationMin?: number;
      durationMode?: 'fixed' | 'auto';
    }
  | { type: 'DELETE_EPISODE'; episodeId: string }
  | { type: 'CLEANUP_STALE_EPISODES' }
  | { type: 'GET_JOB_STATUS' }
  | { type: 'CREATE_DEMO_EPISODE' }
  | { type: 'PASSIVE_CANDIDATES'; candidates: ExtractedCandidate[]; pageUrl: string }
  | { type: 'CONTENT_EXTRACT_NOW'; scrollSteps?: number; customRule?: CustomExtractRule }
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
  | { type: 'VERIFY_GEMINI_KEY'; apiKey?: string }
  | { type: 'START_PUBLISH_JOB'; job: PendingPublishJob }
  | { type: 'GET_PENDING_PUBLISH_JOB' }
  | { type: 'CLEAR_PENDING_PUBLISH_JOB' }
  | { type: 'RADAR_CHECK'; platforms?: ('youtube' | 'x')[] }
  | { type: 'RADAR_IMPORT_YOUTUBE_SUBS' }
  | { type: 'RADAR_IMPORT_X_FOLLOWING'; maxCount?: number }
  | { type: 'RADAR_ADD_TARGET'; platform: 'youtube' | 'x'; input: string; name?: string }
  | { type: 'RADAR_GENERATE_EPISODE'; checkFirst?: boolean }
  | { type: 'SUMMARIZE_YOUTUBE_VIDEO'; videoUrl: string; force?: boolean }
  | { type: 'SUMMARIZE_ACTIVE_YOUTUBE_TAB' }
  | { type: 'GET_DIGEST_PROGRESS' };

export interface PendingPublishJob {
  id: string;
  platform: 'youtube' | 'x';
  targetUrl: string;
  title: string;
  description: string;
  postText: string;
  threadReplyText: string;
  visibility?: 'unlisted' | 'private' | 'public';
  channelName?: string;
  expectedXHandle?: string;
  fileName?: string;
  mimeType?: string;
  videoBase64?: string;
  createdAt: number;
}

export interface DevBuildStatus {
  currentBuild: BuildMeta | null;
  pendingBuild: BuildMeta | null;
}
