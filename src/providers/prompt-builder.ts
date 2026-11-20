import type {
  ChapterSourceRef,
  DialogueTurn,
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
  PodcastEpisode,
} from '../shared/types';
import { SOURCE_META } from '../shared/types';

export interface RawGeneratedScript {
  title: string;
  subtitle: string;
  chapters: Array<{
    title: string;
    summary: string;
    sourceIds: string[];
    turns: Array<{
      speaker: 'HostA' | 'HostB';
      text: string;
      spokenText?: string;
    }>;
  }>;
}

export interface RecentTopicDigest {
  episodeTitle: string;
  createdAt: string;
  chapters: { title: string; summary: string }[];
  coveredUrls: string[];
}

export interface ScriptPromptOptions {
  now?: number;
  recentTopics?: RecentTopicDigest[];
}

function formatAgeJa(iso: string | undefined, now: number): string {
  if (!iso) return '日時不明';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '日時不明';
  const diffMs = Math.max(0, now - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

function formatJstTimestamp(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

/**
 * Filters out stale items (older than maxAgeHours) and URLs already covered in recent episodes.
 * Skipped when `enforceFreshness` is false (e.g., user explicitly asked to turn the active tab into a podcast).
 */
export function filterFreshAndUniqueItems(
  items: FeedItem[],
  recentTopics: RecentTopicDigest[],
  opts: { now?: number; maxAgeHours?: number; enforceFreshness?: boolean } = {}
): { kept: FeedItem[]; droppedStaleIds: string[]; droppedDupIds: string[] } {
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeHours ?? 72) * 3_600_000;
  const enforce = opts.enforceFreshness ?? true;

  if (!enforce) {
    return { kept: items, droppedStaleIds: [], droppedDupIds: [] };
  }

  const coveredUrls = new Set<string>();
  for (const ep of recentTopics) {
    for (const u of ep.coveredUrls) {
      if (u) coveredUrls.add(u);
    }
  }

  const kept: FeedItem[] = [];
  const droppedStaleIds: string[] = [];
  const droppedDupIds: string[] = [];

  for (const item of items) {
    // Always keep synthetic radar summaries
    if (item.url.startsWith('https://agentcast.local/')) {
      kept.push(item);
      continue;
    }

    if (coveredUrls.has(item.canonicalUrl) || coveredUrls.has(item.url)) {
      droppedDupIds.push(item.id);
      continue;
    }

    const pubTs = Date.parse(item.publishedAt || '');
    const capTs = Date.parse(item.capturedAt || '');
    // Only treat publishedAt as a true publication date if it parses and isn't just the capture fallback
    const hasReliablePubDate = Number.isFinite(pubTs) && (!Number.isFinite(capTs) || Math.abs(capTs - pubTs) > 5_000);
    if (hasReliablePubDate && now - pubTs > maxAgeMs) {
      droppedStaleIds.push(item.id);
      continue;
    }

    kept.push(item);
  }

  // Sort freshest first so top-28 serialization prioritizes newest info
  kept.sort((a, b) => {
    const aRadar = a.url.startsWith('https://agentcast.local/') ? 1 : 0;
    const bRadar = b.url.startsWith('https://agentcast.local/') ? 1 : 0;
    if (aRadar !== bRadar) return bRadar - aRadar;
    const ta = Date.parse(a.publishedAt || a.capturedAt || '') || 0;
    const tb = Date.parse(b.publishedAt || b.capturedAt || '') || 0;
    return tb - ta;
  });

  // Safety valve: if everything in queue was older than maxAgeHours, keep the 5 newest non-duplicate items
  if (kept.length === 0 && items.length > 0) {
    const fallback = items
      .filter((i) => !droppedDupIds.includes(i.id))
      .sort(
        (a, b) =>
          (Date.parse(b.publishedAt || b.capturedAt || '') || 0) -
          (Date.parse(a.publishedAt || a.capturedAt || '') || 0)
      )
      .slice(0, 5);
    const fallbackIds = new Set(fallback.map((i) => i.id));
    return {
      kept: fallback,
      droppedStaleIds: droppedStaleIds.filter((id) => !fallbackIds.has(id)),
      droppedDupIds,
    };
  }

  return { kept, droppedStaleIds, droppedDupIds };
}

export function buildPodcastScriptPrompt(
  items: FeedItem[],
  settings: ExtensionSettings,
  options: ScriptPromptOptions = {}
): string {
  const now = options.now ?? Date.now();
  const recentTopics = options.recentTopics ?? [];
  const isAutoDuration = settings.durationMode === 'auto';
  const dur = Math.max(3, Math.min(30, Math.round(settings.targetDurationMin || 10)));
  const targetChapters = isAutoDuration
    ? '素材の情報量に合わせて自然な数（3〜6個程度）'
    : dur <= 5
      ? '2〜3個'
      : dur <= 10
        ? '4〜5個'
        : dur <= 18
          ? '5〜7個'
          : '7〜9個';
  const turnsPerChapter = isAutoDuration
    ? '話題の重要度に応じて5〜10往復'
    : dur <= 5
      ? '4〜6往復'
      : dur <= 10
        ? '6〜9往復'
        : dur <= 18
          ? '8〜12往復'
          : '10〜14往復';
  const durationGuidance = isAutoDuration
    ? '全体尺は素材量に応じて無理なく聴き切れる自然な長さ（おまかせ）に調整し、'
    : `全体の再生時間がおよそ ${dur} 分になるようにペース配分し、`;

  const serializedItems = items
    .slice(0, 28)
    .map((item, idx) => {
      const sourceLabel = SOURCE_META[item.source]?.shortLabel || item.source;
      const bodySnippet = item.content.slice(0, 900);
      const pubTs = Date.parse(item.publishedAt || '');
      const capTs = Date.parse(item.capturedAt || '');
      const isCaptureFallback = Number.isFinite(pubTs) && Number.isFinite(capTs) && Math.abs(capTs - pubTs) <= 5_000;
      const dateLabel = Number.isFinite(pubTs)
        ? `${formatJstTimestamp(pubTs)}（${formatAgeJa(item.publishedAt, now)}${isCaptureFallback ? '・取得時刻' : ''}）`
        : '日時不明';
      return `[ID: ${item.id}] (#${idx + 1} / ${sourceLabel} / 著者: ${item.author} / 日時: ${dateLabel})
タイトル: ${item.title}
URL: ${item.url}
本文抜粋:
${bodySnippet}`;
    })
    .join('\n\n---\n\n');

  const recentSection =
    recentTopics.length > 0
      ? `\n\n## 過去の番組で既に扱ったトピック（直近${recentTopics.length}回・重複回避用）\n` +
        recentTopics
          .slice(0, 8)
          .map((ep) => {
            const epDate = formatJstTimestamp(Date.parse(ep.createdAt) || now);
            const chLines = ep.chapters
              .filter((c) => c.title && !/^(オープニング|導入|エンディング|まとめ)[:：]?$/i.test(c.title))
              .slice(0, 6)
              .map((c) => `  - ${c.title}${c.summary ? `：${c.summary.slice(0, 80)}` : ''}`)
              .join('\n');
            return `- [${epDate}] ${ep.episodeTitle}\n${chLines}`;
          })
          .join('\n')
      : '';

  return `あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。
現在日時: ${formatJstTimestamp(now)}
以下の「ユーザーのフォロー中SNS・購読サイトから集めた未読アイテム一覧」をもとに、2人のパーソナリティ（HostA: ${settings.hostAName}、HostB: ${settings.hostBName}）が自然で知的な掛け合いを行うラジオ番組台本をJSON形式で作成してください。

## パーソナリティ設定
- HostA (${settings.hostAName}): 番組のメイン進行役。要点を整理し、技術的・社会的な背景をわかりやすく噛み砕いて解説する。
- HostB (${settings.hostBName}): 聞き手・深掘り役。リスナー目線で素朴な疑問を投げかけたり、鋭い視点やリアクションを添える。
- 重視する関心テーマ: ${settings.focusTopics}

## 番組構成ルール
1. **情報鮮度の確認（重要）**：各アイテムの「日時」および本文中の日付を確認し、現在日時（${formatJstTimestamp(now)}）に近い最新のニュース・リリース・動画を優先して取り上げてください。数日以上前の古い記事や過去の話題の単なる再掲は原則スキップし、どうしても触れる場合も最新ニュースの背景補足にとどめてください。
2. **過去番組との重複回避と続報の扱い（重要）**：下部の「過去の番組で既に扱ったトピック」と同じニュース・同じ主張の繰り返しは**採用しないでください**。ただし、**同じニュースに対する新しい発表・続報・アップデート・バージョン更新・反響の変化など「前回からの差分」がある場合**は積極的に取り上げ、「以前お伝えした〇〇の続報ですが〜」のように前回からの変化点を明確に語ってください。
3. 同じニュースや関連する話題（例：Yahoo!/Googleニュースの報道とXでの反応、ZennとNoteの類似技術テーマ、同一プロダクトの複数リリースノート）は分かりやすくチャプターに整理・統合し、多角的に紹介してください。
4. **タイトルとサブタイトルの差別化（重要）**：毎回同じ「○月○日 午後のテック＆トレンドダイジェスト」のような汎用タイトルは使わず、**その回の中心トピック・固有名詞を含めた一目で区別できるタイトル**にしてください。また \`subtitle\` には収集内容を解析した**主要トピック2〜3件の要点サマリー（45〜70文字程度）**を必ず入れてください。
5. 英語の記事やリリースノート（Changelog等）が含まれる場合は、**必ず自然な日本語で噛み砕いて解説**してください。バージョン番号やスラッシュコマンド（例: v2.33.0 → バージョン2.33.0、/swarm → スウォームコマンド、SSH → エスエスエイチ）は \`spokenText\` で滑らかに発音できる表記にしてください。
6. ${durationGuidance}全体で ${targetChapters} のトピックチャプター（先頭の短いオープニング挨拶を含む）に編成し、各チャプターは ${turnsPerChapter} のテンポ良い会話にしてください。
7. 音声合成（TTS）で読み上げた際に不自然にならないよう、URL文字列や絵文字はセリフに含めず、難読英単語・略語（例: Vite→ヴィート、PR→プルリクエスト、LLM→エルエルエム）を自然に読める日本語表記を \`spokenText\` に入れてください（通常の字幕表示用は \`text\`）。
8. 出力は**必ず以下のJSONスキーマのみ**（Markdownのコードブロック装飾や前置き文なし）で返してください。

{
  "title": "内容が一目で分かる固有の番組タイトル（例：LINE Dev Community移行＆Gemini 4 Neon解説）",
  "subtitle": "内容を解析した主要トピック要約（例：L-Developer Community自立運営への移行、SSHリモート接続対応、最新AIエージェント動向）",
  "chapters": [
    {
      "title": "チャプター見出し",
      "summary": "このチャプターの要点（1〜2文）",
      "sourceIds": ["参照したアイテムのID配列（例: x-1234abcd）"],
      "turns": [
        {
          "speaker": "HostA",
          "text": "字幕表示用の自然な日本語セリフ",
          "spokenText": "音声読み上げ用に英略語等をカナ補正したセリフ"
        }
      ]
    }
  ]
}${recentSection}

## 収集アイテム一覧
${serializedItems}`;
}

export function parseGeneratedScriptJson(
  rawText: string,
  sourceItems: FeedItem[],
  settings: ExtensionSettings
): { title: string; subtitle: string; chapters: EpisodeChapter[] } {
  // Strip markdown ```json fences or surrounding prose if returned by Web LLM
  let jsonCandidate = rawText.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(jsonCandidate);
  if (fenceMatch) {
    jsonCandidate = fenceMatch[1].trim();
  } else {
    const firstBrace = jsonCandidate.indexOf('{');
    const lastBrace = jsonCandidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonCandidate = jsonCandidate.slice(firstBrace, lastBrace + 1);
    }
  }

  const parsed = JSON.parse(jsonCandidate) as RawGeneratedScript;
  if (!parsed || !Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
    throw new Error('生成された台本JSONに chapters が含まれていません。');
  }

  const itemMap = new Map(sourceItems.map((i) => [i.id, i]));

  const chapters: EpisodeChapter[] = parsed.chapters.map((ch, idx) => {
    const refs: ChapterSourceRef[] = (ch.sourceIds || [])
      .map((id) => itemMap.get(id))
      .filter((item): item is FeedItem => Boolean(item))
      .map((item) => ({
        id: item.id,
        source: item.source,
        title: item.title,
        url: item.url,
        author: item.author,
      }));

    const turns: DialogueTurn[] = (ch.turns || [])
      .filter((t) => t && typeof t.text === 'string' && t.text.trim().length > 0)
      .map((t, turnIdx) => {
        const speaker = t.speaker === 'HostB' ? 'HostB' : 'HostA';
        return {
          id: `ch${idx}-t${turnIdx}`,
          speaker,
          speakerName: speaker === 'HostA' ? settings.hostAName : settings.hostBName,
          text: t.text.trim(),
          spokenText: (t.spokenText || t.text).trim(),
        };
      });

    // Estimate ~5.5 chars/sec in Japanese speech until actual TTS audio replaces durationSec
    const charCount = turns.reduce((acc, t) => acc + t.text.length, 0);
    const estDurationSec = Math.max(8, Math.round(charCount / 5.5));

    return {
      id: `chapter-${idx}`,
      index: idx,
      title: ch.title || `トピック ${idx + 1}`,
      summary: ch.summary || '',
      sourceItems: refs,
      turns,
      durationSec: estDurationSec,
      hasAudioBlob: false,
    };
  });

  const topicTitles = chapters
    .map((c) => c.title.trim())
    .filter((t) => t && !/^(オープニング|導入|エンディング|まとめ)[:：]?$/i.test(t));

  const rawSubtitle = (parsed.subtitle || '').trim();
  const isGenericSubtitle =
    !rawSubtitle ||
    rawSubtitle.length < 10 ||
    /件の新着トピックから編成|トレンド＆テックダイジェスト/.test(rawSubtitle);

  const derivedSubtitle =
    !isGenericSubtitle
      ? rawSubtitle
      : topicTitles.slice(0, 3).join(' / ') || `${sourceItems.length}件の新着トピックから編成`;

  return {
    title: parsed.title || topicTitles[0] || 'agentCast パーソナルダイジェスト',
    subtitle: derivedSubtitle,
    chapters,
  };
}

export function createDemoEpisode(settings: ExtensionSettings): PodcastEpisode {
  const episodeId = `demo-${Date.now()}`;
  const chapters: EpisodeChapter[] = [
    {
      id: 'chapter-0',
      index: 0,
      title: 'オープニング：agentCastへようこそ',
      summary: 'MacBook + Bluetoothイヤホンでの「ながら聴き」操作とチャプタースキップの確認',
      sourceItems: [
        {
          id: 'demo-src-1',
          source: 'zenn',
          title: 'Zenn トレンド & 個人フィード連携ガイド',
          url: 'https://zenn.dev/',
          author: 'agentCast Studio',
        },
      ],
      turns: [
        {
          id: 'ch0-t0',
          speaker: 'HostA',
          speakerName: settings.hostAName,
          text: `おはようございます、${settings.hostAName}です。あなた専用のブラウザ連動ポッドキャスト、エージェントキャストへようこそ！`,
          spokenText: `おはようございます、${settings.hostAName}です。あなた専用のブラウザ連動ポッドキャスト、エージェントキャストへようこそ！`,
        },
        {
          id: 'ch0-t1',
          speaker: 'HostB',
          speakerName: settings.hostBName,
          text: `こんにちは、${settings.hostBName}です！この拡張機能は、普段使っているエックスやノート、ゼン、ヤフーニュース、グーグルニュースのログイン状態を使って、未読の話題をラジオ番組にまとめてくれます。`,
          spokenText: `こんにちは、${settings.hostBName}です！この拡張機能は、普段使っているエックスやノート、ゼン、ヤフーニュース、グーグルニュースのログイン状態を使って、未読の話題をラジオ番組にまとめてくれます。`,
        },
        {
          id: 'ch0-t2',
          speaker: 'HostA',
          speakerName: settings.hostAName,
          text: 'Bluetoothイヤホンの「次の曲へスキップ」操作を押すと、興味のない話題を飛ばして次のチャプターへすぐ移動できます。ぜひ試してみてくださいね。',
          spokenText:
            'ブルートゥースイヤホンの「次の曲へスキップ」操作を押すと、興味のない話題を飛ばして次のチャプターへすぐ移動できます。ぜひ試してみてくださいね。',
        },
      ],
      durationSec: 28,
      hasAudioBlob: false,
    },
    {
      id: 'chapter-1',
      index: 1,
      title: '使い方：受動ストックとワンクリック番組編成',
      summary: '普段のブラウジングで自動的にネタが貯まる仕組みとAIモード切り替え',
      sourceItems: [
        {
          id: 'demo-src-2',
          source: 'x',
          title: 'X (フォロー中タイムライン)',
          url: 'https://x.com/home',
          author: 'X Timeline',
        },
        {
          id: 'demo-src-3',
          source: 'google_news',
          title: 'Google News おすすめトピック',
          url: 'https://news.google.com/',
          author: 'Google News',
        },
      ],
      turns: [
        {
          id: 'ch1-t0',
          speaker: 'HostB',
          speakerName: settings.hostBName,
          text: '番組を作るにはどうすればいいですか？',
          spokenText: '番組を作るにはどうすればいいですか？',
        },
        {
          id: 'ch1-t1',
          speaker: 'HostA',
          speakerName: settings.hostAName,
          text: '上の「5サイト巡回して番組作成」ボタンを押すか、今見ているページを「現在のタブを追加」でキューに入れて生成するだけです。普段エックスや記事をスクロールしている間も、広告を除いて自動で未読ストックに貯まりますよ。',
          spokenText:
            '上の「5サイト巡回して番組作成」ボタンを押すか、今見ているページを「現在のタブを追加」でキューに入れて生成するだけです。普段エックスや記事をスクロールしている間も、広告を除いて自動で未読ストックに貯まりますよ。',
        },
      ],
      durationSec: 22,
      hasAudioBlob: false,
    },
  ];

  return {
    id: episodeId,
    title: 'サウンドチェック：agentCast クイックツアー',
    subtitle: 'MacBook + Bluetoothイヤホン操作と2話者ラジオ再生のテスト番組',
    createdAt: new Date().toISOString(),
    status: 'ready',
    providerLabel: 'Built-in Demo',
    ttsEngineLabel: 'macOS Web Speech (即時再生)',
    chapters,
    totalDurationSec: 50,
    sourceCount: 3,
  };
}
