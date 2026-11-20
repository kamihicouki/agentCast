import type {
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
} from '../../shared/types';
import { buildPodcastScriptPrompt, parseGeneratedScriptJson } from '../prompt-builder';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(400);
  }
}

/**
 * Injected into a signed-in chatgpt.com or gemini.google.com background tab (main personal branch only).
 * Submits the podcast JSON prompt using the user's existing Plus/Pro/Ultra web session and waits for the reply.
 */
async function runDomPromptInWebSession(
  provider: 'chatgpt' | 'gemini',
  promptText: string
): Promise<{ ok: boolean; responseText?: string; error?: string }> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Detect sign-in state
  const href = window.location.href.toLowerCase();
  if (
    href.includes('/auth/login') ||
    href.includes('accounts.google.com') ||
    document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]')
  ) {
    return {
      ok: false,
      error: `${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} にブラウザでログインしてから再実行してください。`,
    };
  }

  // Wait up to 8s for composer input to mount
  const inputSelectors =
    provider === 'chatgpt'
      ? ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'textarea']
      : [
          '.ql-editor[contenteditable="true"]',
          'rich-textarea div[contenteditable="true"]',
          'div[contenteditable="true"][role="textbox"]',
          'textarea',
        ];

  let composer: HTMLElement | null = null;
  for (let i = 0; i < 20; i++) {
    for (const sel of inputSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        composer = el;
        break;
      }
    }
    if (composer) break;
    await wait(400);
  }

  if (!composer) {
    return {
      ok: false,
      error: `${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} の入力欄が見つかりませんでした（ログイン状態をご確認ください）。`,
    };
  }

  const responseSelector =
    provider === 'chatgpt'
      ? '[data-message-author-role="assistant"]'
      : 'message-content, model-response, .model-response-text';

  const initialCount = document.querySelectorAll(responseSelector).length;

  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    composer.value = promptText;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // ProseMirror / Quill contenteditable composer
    composer.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = promptText;
    composer.appendChild(p);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
  }

  await wait(500);

  const sendSelectors =
    provider === 'chatgpt'
      ? [
          'button[data-testid="send-button"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="送信"]',
        ]
      : [
          'button.send-button',
          'button[aria-label*="Send"]',
          'button[aria-label*="送信"]',
          'button[mattooltip*="送信"]',
        ];

  let sendBtn: HTMLButtonElement | null = null;
  for (const sel of sendSelectors) {
    const btn = document.querySelector<HTMLButtonElement>(sel);
    if (btn && !btn.disabled) {
      sendBtn = btn;
      break;
    }
  }

  if (sendBtn) {
    sendBtn.click();
  } else {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
    );
  }

  // Poll until assistant reply finishes streaming (text stabilizes for ~2.8s and includes closing brace)
  let lastLen = 0;
  let stableTicks = 0;
  for (let tick = 0; tick < 110; tick++) {
    await wait(1000);
    const nodes = document.querySelectorAll(responseSelector);
    if (nodes.length <= initialCount) continue;

    const latestNode = nodes[nodes.length - 1];
    const txt = (latestNode?.textContent || '').trim();
    if (!txt) continue;

    if (txt.length === lastLen && txt.includes('{') && txt.includes('}')) {
      stableTicks++;
      if (stableTicks >= 3) {
        return { ok: true, responseText: txt };
      }
    } else {
      lastLen = txt.length;
      stableTicks = 0;
    }
  }

  return {
    ok: false,
    error: 'Webセッションからの応答待機がタイムアウトしました。',
  };
}

export async function runPromptViaWebSession(
  provider: 'chatgpt' | 'gemini',
  prompt: string
): Promise<string> {
  if (__AGENTCAST_TARGET__ !== 'main') {
    throw new Error('Webセッション連携モードは個人用（mainブランチ）ビルド専用です。');
  }

  const targetUrl =
    provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  if (!tab.id) {
    throw new Error('バックグラウンドタブの作成に失敗しました。');
  }

  try {
    await waitForTabComplete(tab.id, 22000);
    await sleep(1800);

    const execResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runDomPromptInWebSession,
      args: [provider, prompt],
    });

    const payload = execResults?.[0]?.result;
    if (!payload?.ok || !payload.responseText) {
      throw new Error(payload?.error || 'Webセッション経由での生成に失敗しました。');
    }
    return payload.responseText;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function generateScriptViaWebSession(
  provider: 'chatgpt' | 'gemini',
  items: FeedItem[],
  settings: ExtensionSettings
): Promise<{ title: string; subtitle: string; chapters: EpisodeChapter[] }> {
  const prompt = buildPodcastScriptPrompt(items, settings);
  const responseText = await runPromptViaWebSession(provider, prompt);
  return parseGeneratedScriptJson(responseText, items, settings);
}
