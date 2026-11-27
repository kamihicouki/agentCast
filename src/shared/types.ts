export type SourceId =
  | 'x'
  | 'note'
  | 'zenn'
  | 'yahoo_news'
  | 'google_news'
  | 'youtube'
  | 'generic';

/** Built-in sources visited by the patrol tab (order = patrol order). */
export const PATROL_SOURCE_IDS: SourceId[] = [
  'x',
  'youtube',
  'note',
  'zenn',
  'yahoo_news',
  'google_news',
];

export type ExtractionStrategy = 'auto' | 'readability' | 'changelog' | 'css_selector' | 'rss';

export type PatrolDepthPreset = 'shallow' | 'standard' | 'deep' | 'custom';

export interface PatrolDepthConfig {
  preset: PatrolDepthPreset;
  /** Scroll steps performed by content script (0..6). */
  scrollSteps: number;
  /** Max items ingested per site per patrol (3..30). */
  maxItems: number;
  /** Max detail/article pages fetched for full body expansion (0..8). */
  deepFetchLimit: number;
  /** Follow external links (e.g. X outbound article links / custom site card links). */
  followOutboundLinks: boolean;
}

export const PATROL_DEPTH_PRESET_META: Record<
  PatrolDepthPreset,
  { label: string; shortLabel: string; description: string }
> = {
  shallow: {
    label: '浅い',
    shortLabel: '浅',
    description: '一覧の見出しだけ高速に取得（スクロールなし・本文展開なし）',
  },
  standard: {
    label: '標準',
    shortLabel: '標準',
    description: '速度と情報量のバランス重視（現行の標準設定）',
  },
  deep: {
    label: '深い',
    shortLabel: '深',
    description: 'しっかりスクロールし、記事本文や外部リンク先まで深掘り',
  },
  custom: {
    label: 'カスタム',
    shortLabel: '調整',
    description: '個別パラメータで微調整された深さ設定',
  },
};

function clampInt(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, Math.round(val)));
}

export function buildPatrolDepthPreset(
  preset: Exclude<PatrolDepthPreset, 'custom'>,
  sourceId?: SourceId
): PatrolDepthConfig {
  if (preset === 'shallow') {
    return {
      preset: 'shallow',
      scrollSteps: 0,
      maxItems: 6,
      deepFetchLimit: 0,
      followOutboundLinks: false,
    };
  }
  if (preset === 'deep') {
    return {
      preset: 'deep',
      scrollSteps: 4,
      maxItems: 20,
      deepFetchLimit: 5,
      followOutboundLinks: true,
    };
  }
  // 'standard' preserves each site's tuned default scroll behavior
  const defaultScroll =
    sourceId === 'x' ? 2 : sourceId === 'note' || sourceId === 'youtube' ? 1 : 0;
  return {
    preset: 'standard',
    scrollSteps: defaultScroll,
    maxItems: 12,
    deepFetchLimit: 2,
    followOutboundLinks: false,
  };
}

export function resolvePatrolDepth(
  sourceId?: SourceId,
  override?: Partial<PatrolDepthConfig>,
  legacyScrollSteps?: number
): PatrolDepthConfig {
  const base = buildPatrolDepthPreset(
    override?.preset && override.preset !== 'custom' ? override.preset : 'standard',
    sourceId
  );
  if (!override) {
    if (typeof legacyScrollSteps === 'number' && legacyScrollSteps > 0) {
      return {
        ...base,
        preset: 'custom',
        scrollSteps: clampInt(legacyScrollSteps, 0, 6, base.scrollSteps),
      };
    }
    return base;
  }
  return {
    preset: override.preset || base.preset,
    scrollSteps: clampInt(override.scrollSteps ?? base.scrollSteps, 0, 6, base.scrollSteps),
    maxItems: clampInt(override.maxItems ?? base.maxItems, 3, 30, base.maxItems),
    deepFetchLimit: clampInt(
      override.deepFetchLimit ?? base.deepFetchLimit,
      0,
      8,
      base.deepFetchLimit
    ),
    followOutboundLinks:
      typeof override.followOutboundLinks === 'boolean'
        ? override.followOutboundLinks
        : base.followOutboundLinks,
  };
}

export interface CustomSiteConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  passiveEnabled: boolean;
  extractionStrategy: ExtractionStrategy;
  cssSelector?: string;
  scrollSteps: number;
  patrolDepth?: PatrolDepthConfig;
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
  youtube: {
    label: 'YouTube (登録チャンネル新着)',
    shortLabel: 'YouTube',
    startUrl: 'https://www.youtube.com/feed/subscriptions',
    description: 'ログイン中の登録チャンネル新着フィードから動画タイトル・チャンネル・長さを収集',
    extractionMethod: 'DOM解析（登録チャンネル）+ 公開RSS + 字幕/概要',
    extractionDetail:
      '/feed/subscriptions の動画カード（ytd-rich-item-renderer）からタイトル・チャンネル・投稿時期・再生時間を取得。動向レーダーではチャンネル毎の公開RSS (feeds/videos.xml) で新着有無を判定し、動画要約は字幕トラック→概要欄の順に本文化します。',
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
  publishedYouTubeUrl?: string;
  publishedYouTubeAt?: string;
  publishedXUrl?: string;
  publishedXAt?: string;
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
export type AutoPublishMode = 'full_auto' | 'manual_confirm';
export type YtToXMediaMode = 'link_only' | 'link_and_video';

export interface PublishSettings {
  youtubeChannelName: string;
  youtubeChannelIdOrUrl: string;
  youtubeDefaultVisibility: YouTubeVisibility;
  youtubeHashtags: string;
  xAccountHandle: string;
  xHashtags: string;
  xAttachVideo: boolean;
  /** For YT -> X auto-linking, attach only the YouTube link (default) or also attach the MP4 video. */
  ytToXMediaMode: YtToXMediaMode;
  /** 'full_auto' clicks final Publish/Post button automatically; 'manual_confirm' stops before final button. */
  autoPublishMode: AutoPublishMode;
  /** Automatically publish to YouTube once episode audio generation finishes. */
  autoPublishAfterGenerateYouTube: boolean;
  /** Automatically post to X.com once episode audio generation finishes (after YouTube if both enabled). */
  autoPublishAfterGenerateX: boolean;
  /** Include the published YouTube video URL in the X.com post text. */
  xIncludeYouTubeUrl: boolean;
}

export const DEFAULT_PUBLISH_SETTINGS: PublishSettings = {
  youtubeChannelName: '',
  youtubeChannelIdOrUrl: '',
  youtubeDefaultVisibility: 'unlisted',
  youtubeHashtags: '#agentCast #AIポッドキャスト #テックニュース',
  xAccountHandle: '',
  xHashtags: '#agentCast #AIラジオ',
  xAttachVideo: false,
  ytToXMediaMode: 'link_only',
  autoPublishMode: 'full_auto',
  autoPublishAfterGenerateYouTube: false,
  autoPublishAfterGenerateX: false,
  xIncludeYouTubeUrl: true,
};

export type DurationMode = 'fixed' | 'auto';

export type AppThemeId = 'braun' | 'graphite' | 'paper' | 'monochrome';

export const APP_THEMES: ReadonlyArray<{
  id: AppThemeId;
  name: string;
  labelJa: string;
  description: string;
  swatchBg: string;
  swatchSurface: string;
  swatchAccent: string;
  swatchInk: string;
}> = [
  {
    id: 'braun',
    name: 'Atelier Light',
    labelJa: 'アトリエ・ライト',
    description: 'マットなオフホワイトとシグナルオレンジ。ディーター・ラムスのオーディオ機器に倣う標準テーマ。',
    swatchBg: '#f3f2ee',
    swatchSurface: '#ffffff',
    swatchAccent: '#d94e1f',
    swatchInk: '#191918',
  },
  {
    id: 'graphite',
    name: 'Studio Dark',
    labelJa: 'スタジオ・ダーク',
    description: '低反射のグラファイトと温かいアンバー。夜間や集中時のリスニング向け。',
    swatchBg: '#141517',
    swatchSurface: '#1d1f22',
    swatchAccent: '#e86a2c',
    swatchInk: '#f0eee9',
  },
  {
    id: 'paper',
    name: 'Editorial Paper',
    labelJa: 'エディトリアル',
    description: '生成りの紙面と深いフォレストグリーン。家具事典のような静謐な編集デザイン。',
    swatchBg: '#f8f5ef',
    swatchSurface: '#fffdf9',
    swatchAccent: '#265947',
    swatchInk: '#211e1b',
  },
  {
    id: 'monochrome',
    name: 'Pure Mono',
    labelJa: 'モノクローム',
    description: '装飾を完全に排した無彩色のスイス・グリッド。最も情報に集中できる構成。',
    swatchBg: '#f5f5f5',
    swatchSurface: '#ffffff',
    swatchAccent: '#111111',
    swatchInk: '#111111',
  },
];

export const GEMINI_VOICES = ['Puck', 'Aoede', 'Kore', 'Charon', 'Fenrir', 'Leda'] as const;

export const GEMINI_TTS_MODELS = [
  { id: 'gemini-3.8-flash-tts', label: 'gemini-3.8-flash-tts（最新・高速）' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'gemini-2.5-flash-preview-tts（標準）' },
  { id: 'gemini-2.5-pro-preview-tts', label: 'gemini-2.5-pro-preview-tts（高品質）' },
] as const;

export const OPENAI_TTS_MODELS = [
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts（自然・最新）' },
  { id: 'tts-1', label: 'tts-1（高速・低コスト）' },
  { id: 'tts-1-hd', label: 'tts-1-hd（高音質）' },
] as const;

export interface ExtensionSettings {
  theme: AppThemeId;
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
  openaiTtsModel: string;
  /** Target podcast length in minutes (slider 3..30) when durationMode === 'fixed'. */
  targetDurationMin: number;
  /** 'fixed' uses targetDurationMin; 'auto' lets the AI fit duration to the material. */
  durationMode: DurationMode;
  enabledSources: Record<SourceId, boolean>;
  /** Per-site patrol depth overrides for built-in sources. */
  sourcePatrolDepth: Partial<Record<SourceId, PatrolDepthConfig>>;
  /** Built-in sources removed by the user from the flat patrol list (can be re-added from presets). */
  removedBuiltinSources: SourceId[];
  customSites: CustomSiteConfig[];
  publish: PublishSettings;
  maxItemsPerPatrol: number;
  passiveCaptureEnabled: boolean;
  autoScheduleEnabled: boolean;
  autoScheduleTime: string;
  playbackRate: number;
  focusTopics: string;
  /** Look-back window (hours) for the very first radar check & script freshness. */
  radarWindowHours: number;
  /** Run the follow radar automatically as part of patrol. */
  radarIncludeInPatrol: boolean;
  /** Only include YouTube channels with new activity when patrolling. */
  youtubeOnlyActiveInPatrol: boolean;
  /** Max X accounts visited per radar run (tab-based, rate-friendly). */
  radarMaxXAccountsPerRun: number;
  /** 'window' keeps side panel open across all tabs; 'tab' shows it only on the tab where it was opened. */
  sidePanelScope?: SidePanelScope;
}

export type SidePanelScope = 'window' | 'tab';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  theme: 'braun',
  sidePanelScope: 'window',
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
  openaiTtsModel: 'tts-1',
  targetDurationMin: 10,
  durationMode: 'fixed',
  enabledSources: {
    x: true,
    note: true,
    zenn: true,
    yahoo_news: true,
    google_news: true,
    youtube: true,
    generic: true,
  },
  sourcePatrolDepth: {},
  removedBuiltinSources: [],
  customSites: [],
  publish: { ...DEFAULT_PUBLISH_SETTINGS },
  maxItemsPerPatrol: 24,
  passiveCaptureEnabled: false,
  autoScheduleEnabled: false,
  autoScheduleTime: '07:30',
  playbackRate: 1.0,
  focusTopics: 'AI・テクノロジー・開発トレンド・主要ニュース',
  radarWindowHours: 72,
  radarIncludeInPatrol: false,
  youtubeOnlyActiveInPatrol: true,
  radarMaxXAccountsPerRun: 12,
};

// ---------------------------------------------------------------------------
// Follow radar (登録チャンネル・フォロー動向)
// ---------------------------------------------------------------------------

export type WatchPlatform = 'youtube' | 'x';
export type WatchStatus = 'active' | 'quiet' | 'unknown' | 'error';

export interface RadarItem {
  id: string;
  title: string;
  url: string;
  publishedAt?: string;
  durationSec?: number;
  excerpt?: string;
}

export interface WatchTarget {
  /** `yt:UCxxxx` / `yt:@handle` / `x:handle` */
  id: string;
  platform: WatchPlatform;
  name: string;
  url: string;
  channelId?: string;
  handle?: string;
  enabled: boolean;
  addedAt: string;
  lastCheckedAt?: string;
  lastActivityAt?: string;
  lastSeenItemIds: string[];
  newCount: number;
  latestItems: RadarItem[];
  status: WatchStatus;
  statusMessage?: string;
}

export type DigestVerdict = 'watch' | 'skim' | 'skip';

export interface VideoDigest {
  videoId: string;
  url: string;
  title: string;
  channelName: string;
  durationSec: number;
  oneLiner: string;
  summary: string[];
  keyPoints: { time: string; point: string }[];
  verdict: DigestVerdict;
  verdictReason: string;
  relevance: number;
  /** transcript / gemini_video / description / heuristic */
  method: 'transcript' | 'gemini_video' | 'description' | 'heuristic';
  createdAt: string;
}

export const DIGEST_VERDICT_META: Record<DigestVerdict, { label: string; emoji: string }> = {
  watch: { label: '見る', emoji: '▶' },
  skim: { label: '流し見', emoji: '⏩' },
  skip: { label: 'スキップ', emoji: '⏭' },
};

export const DIGEST_METHOD_LABEL: Record<VideoDigest['method'], string> = {
  transcript: '字幕全文から要約',
  gemini_video: 'Gemini 動画理解',
  description: '概要欄から要約',
  heuristic: '簡易判定（AI未使用）',
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
