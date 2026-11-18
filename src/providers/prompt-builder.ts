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

export function buildPodcastScriptPrompt(
  items: FeedItem[],
  settings: ExtensionSettings
): string {
  const targetChapters =
    settings.targetDurationMin <= 5 ? '2〜3個' : settings.targetDurationMin <= 10 ? '4〜5個' : '6〜7個';
  const turnsPerChapter =
    settings.targetDurationMin <= 5 ? '4〜6往復' : settings.targetDurationMin <= 10 ? '6〜9往復' : '8〜12往復';

  const serializedItems = items
    .slice(0, 28)
    .map((item, idx) => {
      const sourceLabel = SOURCE_META[item.source]?.shortLabel || item.source;
      const bodySnippet = item.content.slice(0, 900);
      return `[ID: ${item.id}] (#${idx + 1} / ${sourceLabel} / 著者: ${item.author})
タイトル: ${item.title}
URL: ${item.url}
本文抜粋:
${bodySnippet}`;
    })
    .join('\n\n---\n\n');

  return `あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。
以下の「ユーザーのフォロー中SNS・購読サイトから集めた未読アイテム一覧」をもとに、2人のパーソナリティ（HostA: ${settings.hostAName}、HostB: ${settings.hostBName}）が自然で知的な掛け合いを行うラジオ番組台本をJSON形式で作成してください。

## パーソナリティ設定
- HostA (${settings.hostAName}): 番組のメイン進行役。要点を整理し、技術的・社会的な背景をわかりやすく噛み砕いて解説する。
- HostB (${settings.hostBName}): 聞き手・深掘り役。リスナー目線で素朴な疑問を投げかけたり、鋭い視点やリアクションを添える。
- 重視する関心テーマ: ${settings.focusTopics}

## 番組構成ルール
1. 同じニュースや関連する話題（例：Yahoo!/Googleニュースの報道とXでの反応、ZennとNoteの類似技術テーマ）は1つのチャプターに統合し、多角的に紹介してください。
2. 全体で ${targetChapters} のトピックチャプター（先頭の短いオープニング挨拶を含む）に編成し、各チャプターは ${turnsPerChapter} のテンポ良い会話にしてください。
3. 音声合成（TTS）で読み上げた際に不自然にならないよう、URL文字列や絵文字はセリフに含めず、難読英単語・略語（例: Vite→ヴィート、PR→プルリクエスト、LLM→エルエルエム）を自然に読める日本語表記を \`spokenText\` に入れてください（通常の字幕表示用は \`text\`）。
4. 出力は**必ず以下のJSONスキーマのみ**（Markdownのコードブロック装飾や前置き文なし）で返してください。

{
  "title": "番組タイトル（例：11月18日 朝のトレンド＆テックダイジェスト）",
  "subtitle": "取り上げる主要トピックの1行サマリー",
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
}

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

  return {
    title: parsed.title || 'agentCast パーソナルダイジェスト',
    subtitle: parsed.subtitle || `${sourceItems.length}件の新着トピックから編成`,
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
