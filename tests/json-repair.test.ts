import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FeedItem } from '../src/shared/types';
import { parseJsonObjectWithRepair, repairJsonObjectText } from '../src/providers/json-repair';
import { parseGeneratedScriptJson } from '../src/providers/prompt-builder';
import { parseVideoDigestJson, type VideoSourceMaterial } from '../src/providers/video-digest';

const SAMPLE_ITEMS: FeedItem[] = [
  {
    id: 'x-1001',
    source: 'x',
    url: 'https://x.com/user/status/1',
    canonicalUrl: 'https://x.com/user/status/1',
    title: 'AIエージェント最新動向',
    author: 'dev_user',
    content: '最新のAIエージェント基盤について解説。',
    excerpt: '最新のAIエージェント基盤について解説。',
    outboundUrls: [],
    publishedAt: '2026-11-23T08:00:00Z',
    capturedAt: '2026-11-23T09:00:00Z',
    engagementScore: 100,
    consumedInEpisodeId: null,
  },
  {
    id: 'zenn-2002',
    source: 'zenn',
    url: 'https://zenn.dev/example/articles/abc',
    canonicalUrl: 'https://zenn.dev/example/articles/abc',
    title: 'TypeScript設計メモ',
    author: 'zenn_author',
    content: '型安全なパーサー設計の解説。',
    excerpt: '型安全なパーサー設計の解説。',
    outboundUrls: [],
    publishedAt: '2026-11-23T07:00:00Z',
    capturedAt: '2026-11-23T09:00:00Z',
    engagementScore: 80,
    consumedInEpisodeId: null,
  },
];

describe('json-repair & parseGeneratedScriptJson resilience', () => {
  it('parses valid script JSON cleanly without invoking repair', () => {
    const valid = JSON.stringify(
      {
        title: 'AIエージェントとTypeScript特集',
        subtitle: '最新AIエージェント基盤と型安全なパーサー設計を2人で深掘り解説します',
        chapters: [
          {
            title: 'AIエージェント最新動向',
            summary: 'エージェント基盤の進化を整理',
            sourceIds: ['x-1001'],
            turns: [
              { speaker: 'HostA', text: '今日はAIエージェントの話題です。', spokenText: '今日はエーアイエージェントの話題です。' },
              { speaker: 'HostB', text: '気になりますね！', spokenText: '気になりますね！' },
            ],
          },
        ],
      },
      null,
      2
    );

    const rawRes = parseJsonObjectWithRepair(valid, { preferKeys: ['chapters'] });
    expect(rawRes.repaired).toBe(false);

    const parsed = parseGeneratedScriptJson(valid, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.title).toBe('AIエージェントとTypeScript特集');
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].turns).toHaveLength(2);
    expect(parsed.chapters[0].sourceItems).toHaveLength(1);
  });

  it('recovers from missing commas between array elements (Exact V8 "Expected \',\' or \']\' after array element" error)', () => {
    // Reproduces the exact SyntaxError shown in v0.7.1:
    // "Expected ',' or ']' after array element in JSON at position ..."
    const broken = `{
  "title": "大型ニュース解説",
  "subtitle": "AIエージェント最新動向とTypeScript設計メモの2本立てダイジェスト",
  "chapters": [
    {
      "title": "第1章：AIエージェント",
      "summary": "要点1",
      "sourceIds": ["x-1001" "zenn-2002"],
      "turns": [
        {
          "speaker": "HostA",
          "text": "最初のセリフです。",
          "spokenText": "最初のセリフです。"
        }
        {
          "speaker": "HostB",
          "text": "カンマが抜けた2つ目のセリフです。",
          "spokenText": "カンマが抜けた2つ目のセリフです。"
        }
      ]
    }
    {
      "title": "第2章：TypeScript設計",
      "summary": "要点2",
      "sourceIds": ["zenn-2002"],
      "turns": [
        {
          "speaker": "HostA",
          "text": "2章目のセリフです。",
          "spokenText": "2章目のセリフです。"
        }
      ]
    }
  ]
}`;

    // Verify strict JSON.parse indeed throws the V8 array-element SyntaxError
    expect(() => JSON.parse(broken)).toThrow(/Expected ',' or ']' after array element/);

    const parsed = parseGeneratedScriptJson(broken, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].turns).toHaveLength(2);
    expect(parsed.chapters[0].sourceItems).toHaveLength(2);
    expect(parsed.chapters[1].title).toBe('第2章：TypeScript設計');
  });

  it('recovers from a 37KB+ (~800+ lines) truncated script JSON cut off mid-chapter', () => {
    const turns = Array.from({ length: 180 }, (_, idx) => ({
      speaker: idx % 2 === 0 ? 'HostA' : 'HostB',
      text: `これは長尺エピソードのセリフ番号${idx + 1}です。最新のAI開発ツールやエージェント設計について丁寧に解説します。`,
      spokenText: `これは長尺エピソードのセリフ番号${idx + 1}です。最新のエーアイ開発ツールやエージェント設計について丁寧に解説します。`,
    }));

    const fullObj = {
      title: '超長尺テック総まとめ',
      subtitle: '最新AIエージェント開発とTypeScript設計パターンを徹底的に深掘り',
      chapters: [
        {
          title: '第1章：AI基盤の進化',
          summary: '長尺テスト1',
          sourceIds: ['x-1001'],
          turns: turns.slice(0, 90),
        },
        {
          title: '第2章：実装テクニック',
          summary: '長尺テスト2',
          sourceIds: ['zenn-2002'],
          turns: turns.slice(90, 180),
        },
      ],
    };

    const fullJson = JSON.stringify(fullObj, null, 2);
    expect(fullJson.length).toBeGreaterThan(37_000);
    expect(fullJson.split('\n').length).toBeGreaterThan(818);

    // Simulate truncation right after a turn closing brace (missing ] } ] })
    const cutAt = fullJson.lastIndexOf('      }', fullJson.length - 400);
    expect(cutAt).toBeGreaterThan(35_000);
    const truncated = fullJson.slice(0, cutAt + '      }'.length);

    expect(() => JSON.parse(truncated)).toThrow(/Expected ',' or ']' after array element|Unexpected end/);

    const parsed = parseGeneratedScriptJson(truncated, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.title).toBe('超長尺テック総まとめ');
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].turns).toHaveLength(90);
    expect(parsed.chapters[1].turns.length).toBeGreaterThan(80);
  });

  it('recovers from truncation mid-string, mid-key, or right after a colon/comma and drops empty trailing chapters', () => {
    const truncatedMidChapter = `\`\`\`json
{
  "title": "途中切断テスト",
  "subtitle": "AIエージェント最新動向と設計パターンの解説サマリー",
  "chapters": [
    {
      "title": "完成した第1章",
      "summary": "ここは完全に生成された",
      "sourceIds": ["x-1001"],
      "turns": [
        {
          "speaker": "HostA",
          "text": "こんにちは、完成したセリフです。",
          "spokenText": "こんにちは、完成したセリフです。"
        },
        {
          "speaker": "HostB",
          "text": "なるほど、わかりやすいですね！",
          "spokenText": "なるほど、わかりやすいですね！"
        }
      ]
    },
    {
      "title": "途中で切れた第2章",
      "summary": "セリフが出る前に切れ`;

    const parsed = parseGeneratedScriptJson(truncatedMidChapter, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    // The empty trailing chapter with 0 turns should be dropped, preserving Chapter 1 intact
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].title).toBe('完成した第1章');
    expect(parsed.chapters[0].turns).toHaveLength(2);
  });

  it('repairs unescaped double quotes inside Japanese dialogue text including comma-separated quotes', () => {
    const broken = `{
  "title": "引用符トラブル検証",
  "subtitle": "日本語セリフ内の未エスケープ引用符を安全に修復するテストケース",
  "chapters": [
    {
      "title": "引用の多い技術解説",
      "summary": "引用符テスト",
      "sourceIds": ["x-1001"],
      "turns": [
        {
          "speaker": "HostA",
          "text": "今回の注目は"Agentic Coding"という概念で、特徴は"高速", "軽量"の2点です。",
          "spokenText": "今回の注目はエージェンティックコーディングという概念で、特徴は高速、軽量の2点です。"
        },
        {
          "speaker": "HostB",
          "text": "設定例は{"mode": "auto"}の形式で書くんですよね？",
          "spokenText": "設定例はモードオートで書くんですよね？"
        }
      ]
    }
  ]
}`;

    expect(() => JSON.parse(broken)).toThrow();

    const parsed = parseGeneratedScriptJson(broken, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.chapters[0].turns).toHaveLength(2);
    expect(parsed.chapters[0].turns[0].text).toBe(
      '今回の注目は"Agentic Coding"という概念で、特徴は"高速", "軽量"の2点です。'
    );
    expect(parsed.chapters[0].turns[1].text).toBe('設定例は{"mode": "auto"}の形式で書くんですよね？');
  });

  it('repairs mismatched closing delimiters (omitted ] or typo } for ])', () => {
    const omittedBracket = `{
  "title": "括弧ズレ修復テスト",
  "subtitle": "閉じ角括弧が抜けた場合でも後続チャプターを壊さず修復します",
  "chapters": [
    {
      "title": "第1章",
      "summary": "概要1",
      "sourceIds": ["x-1001"],
      "turns": [
        { "speaker": "HostA", "text": "セリフ1", "spokenText": "セリフ1" }
    },
    {
      "title": "第2章",
      "summary": "概要2",
      "sourceIds": ["zenn-2002"],
      "turns": [
        { "speaker": "HostB", "text": "セリフ2", "spokenText": "セリフ2" }
      }
    }
  ]
}`;

    expect(() => JSON.parse(omittedBracket)).toThrow();
    const parsed = parseGeneratedScriptJson(omittedBracket, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters[0].turns[0].text).toBe('セリフ1');
    expect(parsed.chapters[1].turns[0].text).toBe('セリフ2');
  });

  it('repairs trailing commas, missing property commas, comments, raw newlines, and invalid escapes', () => {
    const messy = `はい、台本を作成しました（参考: {context}）。
\`\`\`json
{
  // 番組ヘッダ
  "title": "コード解説番組"
  "subtitle": "正規表現やMarkdownコードブロックを含む台本の安全なパース検証",
  "chapters": [
    {
      "title": "Markdownと正規表現",
      "summary": "エスケープ検証",
      "sourceIds": ["zenn-2002",],
      "turns": [
        {
          "speaker": "HostA",
          "text": "1行目です
2行目では \\s や \\_ や \\' や \`\`\`python を説明します。",
          "spokenText": "1行目と2行目の解説です。",
        },
      ],
    },
  ],
}
\`\`\`
補足: 出力形式 {v2} に準拠しています。`;

    const parsed = parseGeneratedScriptJson(messy, SAMPLE_ITEMS, DEFAULT_SETTINGS);
    expect(parsed.title).toBe('コード解説番組');
    expect(parsed.chapters).toHaveLength(1);
    expect(parsed.chapters[0].turns[0].text).toContain('```python');
    expect(parsed.chapters[0].turns[0].text).toContain('2行目');
  });

  it('recovers malformed YouTube video digest JSON via parseVideoDigestJson', () => {
    const material: VideoSourceMaterial = {
      info: {
        videoId: 'abc12345678',
        title: 'テスト動画',
        author: 'Tech Channel',
        lengthSec: 600,
        description: '概要欄',
        captionTracks: [],
      },
      transcript: '',
    };

    const brokenDigest = `{
  "oneLiner": "これは"必見"の最新AI解説動画です",
  "summary": [
    "要点1"
    "要点2",
  ],
  "keyPoints": [
    {"time": "01:20", "point": "デモ開始"}
    {"time": "05:00", "point": "まとめ"}
  ],
  "verdict": "watch",
  "verdictReason": "関心に強く一致しています。",
  "relevance": 92,
}`;

    const digest = parseVideoDigestJson(brokenDigest, material, 'description');
    expect(digest.oneLiner).toBe('これは"必見"の最新AI解説動画です');
    expect(digest.summary).toEqual(['要点1', '要点2']);
    expect(digest.keyPoints).toHaveLength(2);
    expect(digest.verdict).toBe('watch');
    expect(digest.relevance).toBe(92);
  });

  it('throws a clear Japanese error when the response contains no JSON at all', () => {
    expect(() =>
      parseGeneratedScriptJson('申し訳ありませんが、リクエストを処理できませんでした。', SAMPLE_ITEMS, DEFAULT_SETTINGS)
    ).toThrow(/台本JSONの解析に失敗しました/);
  });

  it('repairJsonObjectText safely terminates on malformed trailing tokens without hanging', () => {
    const repaired = repairJsonObjectText('{"a": 1, "b": tru');
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: true });
  });
});
