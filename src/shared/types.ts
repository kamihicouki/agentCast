export type SourceId = 'x' | 'note' | 'zenn' | 'yahoo_news' | 'google_news' | 'generic';

export const SOURCE_META: Record<
  SourceId,
  { label: string; shortLabel: string; startUrl: string; description: string }
> = {
  x: {
    label: 'X (フォロー中 / Home)',
    shortLabel: 'X.com',
    startUrl: 'https://x.com/home',
    description: 'ログイン中のタイムラインから広告を除いて注目ポストと引用リンクを抽出',
  },
  note: {
    label: 'Note (フォロー新着・購読記事)',
    shortLabel: 'Note',
    startUrl: 'https://note.com/',
    description: 'フォロー中クリエイターの記事や購入済み・メンバーシップ記事本文を抽出',
  },
  zenn: {
    label: 'Zenn (トレンド & フィード)',
    shortLabel: 'Zenn',
    startUrl: 'https://zenn.dev/',
    description: '技術トレンドRSSとログイン中フィードを取得（コードブロックは要点化）',
  },
  yahoo_news: {
    label: 'Yahoo!ニュース (主要・マイニュース)',
    shortLabel: 'Yahoo!',
    startUrl: 'https://news.yahoo.co.jp/',
    description: '主要トピックスからピックアップ経由で元記事本文を解決・収集',
  },
  google_news: {
    label: 'Google News (おすすめ・フォロー中)',
    shortLabel: 'GNews',
    startUrl: 'https://news.google.com/',
    description: 'Googleアカウント連動のパーソナライズ報道クラスターを収集',
  },
  generic: {
    label: '開いているWeb記事 (Readability)',
    shortLabel: 'Web',
    startUrl: '',
    description: '任意のニュース・ブログ・有料メルマガ等を現在のタブから本文抽出',
  },
};

export interface ExtractedCandidate {
  source: SourceId;
  url: string;
  title: string;
  author: string;
  authorHandle?: string;
  content: string;
  outboundUrls: string[];
  publishedAt?: string;
  engagementScore?: number;
  needsFullArticleFetch?: boolean;
}

export interface FeedItem {
  id: string;
  source: SourceId;
  url: string;
  canonicalUrl: string;
  title: string;
  author: string;
  authorHandle?: string;
  content: string;
  excerpt: string;
  outboundUrls: string[];
  publishedAt: string;
  capturedAt: string;
  engagementScore: number;
  consumedInEpisodeId: string | null;
}

export interface DialogueTurn {
  id: string;
  speaker: 'HostA' | 'HostB';
  speakerName: string;
  text: string;
  spokenText?: string;
}

export interface ChapterSourceRef {
  id: string;
  source: SourceId;
  title: string;
  url: string;
  author?: string;
}

export interface EpisodeChapter {
  id: string;
  index: number;
  title: string;
  summary: string;
  sourceItems: ChapterSourceRef[];
  turns: DialogueTurn[];
  durationSec: number;
  hasAudioBlob: boolean;
}

export type EpisodeStatus =
  | 'collecting'
  | 'generating_script'
  | 'synthesizing_audio'
  | 'ready'
  | 'error';

export interface PodcastEpisode {
  id: string;
  title: string;
  subtitle: string;
  createdAt: string;
  status: EpisodeStatus;
  statusDetail?: string;
  providerLabel: string;
  ttsEngineLabel: string;
  chapters: EpisodeChapter[];
  totalDurationSec: number;
  sourceCount: number;
  errorMessage?: string;
}

export type AIMode = 'gemini_api' | 'openai_api' | 'web_chatgpt' | 'web_gemini';
export type TTSMode = 'gemini_tts' | 'openai_tts' | 'macos_speech';

export interface ExtensionSettings {
  aiMode: AIMode;
  ttsMode: TTSMode;
  geminiApiKey: string;
  geminiModel: string;
  geminiTtsModel: string;
  hostAName: string;
  hostBName: string;
  hostAVoice: string;
  hostBVoice: string;
  openaiApiKey: string;
  openaiModel: string;
  targetDurationMin: 5 | 10 | 15;
  enabledSources: Record<SourceId, boolean>;
  maxItemsPerPatrol: number;
  passiveCaptureEnabled: boolean;
  autoScheduleEnabled: boolean;
  autoScheduleTime: string;
  playbackRate: number;
  focusTopics: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  aiMode: 'gemini_api',
  ttsMode: 'gemini_tts',
  geminiApiKey: '',
  geminiModel: 'gemini-flash-latest',
  geminiTtsModel: 'gemini-3.8-flash-tts',
  hostAName: 'カイ',
  hostBName: 'ミオ',
  hostAVoice: 'Puck',
  hostBVoice: 'Aoede',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  targetDurationMin: 10,
  enabledSources: {
    x: true,
    note: true,
    zenn: true,
    yahoo_news: true,
    google_news: true,
    generic: true,
  },
  maxItemsPerPatrol: 24,
  passiveCaptureEnabled: true,
  autoScheduleEnabled: false,
  autoScheduleTime: '07:30',
  playbackRate: 1.0,
  focusTopics: 'AI・テクノロジー・開発トレンド・主要ニュース',
};

export interface PlaybackState {
  episodeId: string | null;
  episodeTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  turnIndex: number;
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  playbackRate: number;
  mode: 'audio_blob' | 'web_speech' | 'idle';
}

export const INITIAL_PLAYBACK_STATE: PlaybackState = {
  episodeId: null,
  episodeTitle: '',
  chapterIndex: 0,
  chapterTitle: '',
  turnIndex: 0,
  isPlaying: false,
  currentTimeSec: 0,
  durationSec: 0,
  playbackRate: 1.0,
  mode: 'idle',
};

export interface BuildMeta {
  buildId: string;
  contentHash: string;
  builtAt: string;
  target: 'main' | 'production';
  version: string;
}
