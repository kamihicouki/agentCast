// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  runDomReadWebSessionState,
  runDomSubmitPromptInWebSession,
} from '../src/providers/personal-only/web-llm-bridge';

const SAMPLE_SCRIPT_JSON = JSON.stringify(
  {
    title: 'テスト番組タイトル',
    subtitle: '最新テック動向の要約',
    chapters: [
      {
        title: 'オープニング',
        summary: '挨拶と導入',
        sourceIds: ['src-1'],
        turns: [
          { speaker: 'HostA', text: 'こんにちは！', spokenText: 'こんにちは！' },
          { speaker: 'HostB', text: 'よろしくお願いします！', spokenText: 'よろしくお願いします！' },
        ],
      },
    ],
  },
  null,
  2
);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Web session DOM submit & state reader (Gemini / ChatGPT)', () => {
  it('extracts complete Gemini JSON even when model-thoughts and trailing empty message-content exist', () => {
    document.body.innerHTML = `
      <main>
        <user-query>ラジオ番組台本をJSON形式で作成してください</user-query>
        <model-response>
          <model-thoughts>
            <message-content>思考プロセス: 構成を検討中...</message-content>
          </model-thoughts>
          <message-content class="model-response-text">
            <div class="markdown"><pre><code>${SAMPLE_SCRIPT_JSON}</code></pre></div>
          </message-content>
          <message-content class="model-response-text"></message-content>
          <message-actions>
            <button aria-label="高評価">thumb_up</button>
            <button aria-label="コピー">content_copy</button>
          </message-actions>
        </model-response>
      </main>
    `;

    const state = runDomReadWebSessionState('gemini', 0, '');
    expect(state.ok).toBe(true);
    expect(state.hasCompleteJson).toBe(true);
    expect(state.isGenerating).toBe(false);
    expect(state.hasCompletionUi).toBe(true);
    expect(JSON.parse(state.responseText).title).toBe('テスト番組タイトル');
  });

  it('does not falsely mark partial streaming JSON as complete when inner turn object closes', () => {
    const partialJson = `{
  "title": "途中までの番組",
  "chapters": [
    {
      "title": "第1章",
      "turns": [
        { "speaker": "HostA", "text": "最初のセリフ", "spokenText": "最初のセリフ" },
        { "speaker": "HostB", "text": "まだ生成中`;

    document.body.innerHTML = `
      <main>
        <model-response>
          <message-content class="model-response-text">${partialJson}</message-content>
        </model-response>
        <button aria-label="回答を停止">停止</button>
      </main>
    `;

    const state = runDomReadWebSessionState('gemini', 0, '');
    expect(state.ok).toBe(true);
    expect(state.hasCompleteJson).toBe(false);
    expect(state.isGenerating).toBe(true);
    expect(state.responseText).toContain('途中までの番組');
  });

  it('still extracts new Gemini JSON even when initialCount was non-zero before submit', () => {
    document.body.innerHTML = `
      <main>
        <model-response>
          <message-content class="model-response-text">${SAMPLE_SCRIPT_JSON}</message-content>
        </model-response>
      </main>
    `;

    const state = runDomReadWebSessionState('gemini', 3, 'こんにちは、今日はどのようなご用件ですか？');
    expect(state.ok).toBe(true);
    expect(state.hasCompleteJson).toBe(true);
    expect(JSON.parse(state.responseText).chapters).toHaveLength(1);
  });

  it('strips code-block headers and extracts fenced JSON cleanly', () => {
    document.body.innerHTML = `
      <main>
        <model-response>
          <message-content>
            <div class="code-block-header"><span>JSON</span><button>コピー</button></div>
            <div class="markdown">\`\`\`json\n${SAMPLE_SCRIPT_JSON}\n\`\`\`</div>
          </message-content>
        </model-response>
      </main>
    `;

    const state = runDomReadWebSessionState('gemini', 0, '');
    expect(state.ok).toBe(true);
    expect(state.hasCompleteJson).toBe(true);
    expect(state.responseText).not.toContain('コピー');
  });

  it('submits prompt into Gemini contenteditable composer and clicks send button', async () => {
    let clicked = false;
    document.body.innerHTML = `
      <main>
        <rich-textarea>
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </rich-textarea>
        <button class="send-button" aria-label="プロンプトを送信">Send</button>
      </main>
    `;
    const btn = document.querySelector<HTMLButtonElement>('button.send-button')!;
    btn.addEventListener('click', () => {
      clicked = true;
    });

    const res = await runDomSubmitPromptInWebSession('gemini', 'テストプロンプト本文');
    expect(res.ok).toBe(true);
    expect(clicked).toBe(true);
    expect(document.querySelector('.ql-editor')?.textContent).toBe('テストプロンプト本文');
  });
});
