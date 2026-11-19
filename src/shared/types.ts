export type SourceId = 'x' | 'note' | 'zenn' | 'yahoo_news' | 'google_news' | 'generic';

export type ExtractionStrategy = 'auto' | 'readability' | 'changelog' | 'css_selector' | 'rss';

export interface CustomSiteConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  passiveEnabled: boolean;
  extractionStrategy: ExtractionStrategy;
  cssSelector?: string;
  scrollSteps: number;
  notes?: string;
}

export const EXTRACTION_STRATEGY_META: Record<
  ExtractionStrategy,
  { label: string; description: string }
> = {
  auto: {
    label: '自動判定（推奨）',
    description:
      'URLやDOM構造から Changelog / サイト専用パーサー / Readability 本文抽出を自動選択します。',
  },
  readability: {
    label: '記事本文抽出 (Readability)',
    description:
      'Mozilla Readability アルゴリズムでナビ・広告・フッターを除外し、記事本文テキストのみを抽出します。',
  },
  changelog: {
    label: 'リリースノート (Changelog)',
    description:
      'アクティブなタブパネル内のバージョン見出し・変更リスト・折りたたみ詳細をリリース単位で構造化抽出します。',
  },
  css_selector: {
    label: 'CSSセレクタ指定',
    description:
      '指定した CSS セレクタ（例: article, .post-card）に一致する各要素からタイトル・リンク・本文を抽出します。',
  },
  rss: {
    label: 'RSS / Atom フィード',
    description:
      'タブを開かずに XML フィードを直接 fetch して <item>/<entry> を高速収集します（ログイン不要な公開サイト向け）。',
  },
};

export const SOURCE_META: Record<
  SourceId,
  {
    label: string;
    shortLabel: string;
    startUrl: string;
    description: string;
    extractionMethod: string;
    extractionDetail: string;
  }
> = {
  x: {
    label: 'X (フォロー中 / Home)',
    shortLabel: 'X.com',
    startUrl: 'https://x.com/home',
    description: 'ログイン中のタイムラインから広告を除いて注目ポストと引用リンクを抽出',
    extractionMethod: 'DOM解析 + 2回スクロール + 広告除外',
    extractionDetail:
      'article[data-testid="tweet"] から本文・著者・エンゲージメント数・引用URLを取得。「プロモーション/Ad」マーカー付き投稿は除外します。',
  },
  note: {
    label: 'Note (フォロー新着・購読記事)',
    shortLabel: 'Note',
    startUrl: 'https://note.com/',
    description: 'フォロー中クリエイターの記事や購入済み・メンバーシップ記事本文を抽出',
    extractionMethod: 'DOM解析 + 記事本文展開',
    extractionDetail:
      '一覧カードから記事URLを収集し、上位記事の .note-common-styles__textnote-body を展開して本文を取得します。',
  },
  zenn: {
    label: 'Zenn (トレンド & フィード)',
    shortLabel: 'Zenn',
    startUrl: 'https://zenn.dev/',
    description: '技術トレンドRSSとログイン中フィードを取得（コードブロックは要点化）',
    extractionMethod: 'RSS先行取得 + DOM本文展開（コード要約）',
    extractionDetail:
      'zenn.dev/feed のRSSを高速取得しつつ、記事ページの .znc 本文を抽出。読み上げにくい <pre><code> は言語名と概要に置換します。',
  },
  yahoo_news: {
    label: 'Yahoo!ニュース (主要・マイニュース)',
    shortLabel: 'Yahoo!',
    startUrl: 'https://news.yahoo.co.jp/',
    description: '主要トピックスからピックアップ経由で元記事本文を解決・収集',
    extractionMethod: 'ピックアップ → 元記事URL追跡',
    extractionDetail:
      'トピックス一覧から pickup ページを経由し「記事全文を読む」リンク先の /articles/ 本文を自動取得します。',
  },
  google_news: {
    label: 'Google News (おすすめ・フォロー中)',
    shortLabel: 'GNews',
    startUrl: 'https://news.google.com/',
    description: 'Googleアカウント連動のパーソナライズ報道クラスターを収集',
    extractionMethod: 'ログイン中DOM解析（見出し＋媒体名）',
    extractionDetail:
      'ログイン済み Google News 画面の <article> カードから報道タイトル・媒体名・日時を構造化収集します。',
  },
  generic: {
    label: 'カスタムサイト / 開いているWeb記事',
    shortLabel: 'Web',
    startUrl: '',
    description: '任意のニュース・ブログ・Changelog・RSS等を自動抽出またはルール指定で収集',
    extractionMethod: '自動判定 (Changelog / Readability / CSS / RSS)',
    extractionDetail:
      'ページ構造に応じて Changelog 専用パーサーや Mozilla Readability でノイズを除いた本文を抽出します。',
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
  updatedAt?: string;
  status: EpisodeStatus;
  statusDetail?: string;
  providerLabel: string;
  ttsEngineLabel: string;
  chapters: EpisodeChapter[];
  totalDurationSec: number;
  sourceCount: number;
  errorMessage?: string;
}

export interface TabGroupSummary {
  id: number;
  title: string;
  color: string;
  tabCount: number;
}

export type AIMode = 'gemini_api' | 'openai_api' | 'web_chatgpt' | 'web_gemini';
export type TTSMode = 'gemini_tts' | 'openai_tts' | 'macos_speech';
export type YouTubeVisibility = 'unlisted' | 'private' | 'public';

export interface PublishSettings {
  youtubeChannelName: string;
  youtubeChannelIdOrUrl: string;
  youtubeDefaultVisibility: YouTubeVisibility;
  youtubeHashtags: string;
  xAccountHandle: string;
  xHashtags: string;
  xAttachVideo: boolean;
}

export const DEFAULT_PUBLISH_SETTINGS: PublishSettings = {
  youtubeChannelName: '',
  youtubeChannelIdOrUrl: '',
  youtubeDefaultVisibility: 'unlisted',
  youtubeHashtags: '#agentCast #AIポッドキャスト #テックニュース',
  xAccountHandle: '',
  xHashtags: '#agentCast #AIラジオ',
  xAttachVideo: true,
};

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
  customSites: CustomSiteConfig[];
  publish: PublishSettings;
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
  customSites: [],
  publish: { ...DEFAULT_PUBLISH_SETTINGS },
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
