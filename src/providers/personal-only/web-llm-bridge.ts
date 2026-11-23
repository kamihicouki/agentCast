import type {
  EpisodeChapter,
  ExtensionSettings,
  FeedItem,
} from '../../shared/types';
import {
  buildPodcastScriptPrompt,
  parseGeneratedScriptJson,
  type ScriptPromptOptions,
} from '../prompt-builder';

export const AGENTCAST_NOTEBOOK_NAME = 'agentcast';

export interface WebSessionPromptOptions {
  /** When provider is 'gemini', ensure this notebook exists and add the generated chat to it. */
  notebookName?: string;
  /** Optional progress callback invoked from the Service Worker polling loop. */
  onProgress?: (detail: string) => void;
}

export interface WebSessionSubmitResult {
  ok: boolean;
  error?: string;
  initialCount: number;
  initialLastText: string;
}

export interface WebSessionPollState {
  ok: boolean;
  error?: string;
  responseText: string;
  hasCompleteJson: boolean;
  isGenerating: boolean;
  hasCompletionUi: boolean;
  responseCount: number;
}

export interface GeminiNotebookCurrentChatResult {
  ok: boolean;
  notebookName: string;
  createdNotebook: boolean;
  status: 'added' | 'already' | 'failed';
  chatId?: string;
  error?: string;
}

export interface GeminiNotebookOrganizeResult {
  ok: boolean;
  notebookName: string;
  createdNotebook: boolean;
  totalScanned: number;
  addedCount: number;
  alreadyCount: number;
  skippedCount: number;
  failedCount: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure helper (also duplicated inside injected DOM scripts) that identifies
 * whether a Gemini conversation belongs to an agentCast podcast script.
 */
export function isAgentCastScriptText(text: string): boolean {
  if (!text) return false;
  if (
    text.includes('ポッドキャスト番組の構成作家') ||
    text.includes('ユーザーのフォロー中SNS・購読サイトから集めた未読アイテム一覧') ||
    text.includes('ラジオ番組台本をJSON形式で作成してください')
  ) {
    return true;
  }
  return (
    text.includes('"chapters"') &&
    text.includes('"turns"') &&
    (text.includes('"HostA"') || text.includes('"spokenText"') || text.includes('"sourceIds"'))
  );
}

export function extractGeminiChatIdFromUrl(url?: string): string {
  if (!url) return '';
  const m = url.match(/\/app\/([a-zA-Z0-9_-]+)/);
  return m?.[1] || '';
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(400);
  }
}

/**
 * Injected once into a signed-in chatgpt.com or gemini.google.com tab (main personal branch only).
 * Verifies sign-in state, snapshots existing response count/text, enters the prompt, and clicks Send.
 * Exported for jsdom unit testing.
 */
export async function runDomSubmitPromptInWebSession(
  provider: 'chatgpt' | 'gemini',
  promptText: string
): Promise<WebSessionSubmitResult> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
  const d = (ms: number) => (isJsdom ? Math.min(ms, 15) : ms);

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
      initialCount: 0,
      initialLastText: '',
    };
  }

  // Wait up to 10s for composer input to mount
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
  for (let i = 0; i < 25; i++) {
    for (const sel of inputSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        composer = el;
        break;
      }
    }
    if (composer) break;
    await wait(d(400));
  }

  if (!composer) {
    return {
      ok: false,
      error: `${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} の入力欄が見つかりませんでした（ログイン状態をご確認ください）。`,
      initialCount: 0,
      initialLastText: '',
    };
  }

  const containerSelector =
    provider === 'chatgpt'
      ? '[data-message-author-role="assistant"]'
      : 'model-response, message-content, .model-response-text';

  const existingNodes = Array.from(document.querySelectorAll<HTMLElement>(containerSelector));
  const initialCount = existingNodes.length;
  const initialLastText =
    existingNodes.length > 0
      ? (existingNodes[existingNodes.length - 1]?.textContent || '').trim().slice(0, 400)
      : '';

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
    composer.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText })
    );
  }

  await wait(d(500));

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
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
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

  return {
    ok: true,
    initialCount,
    initialLastText,
  };
}

/**
 * Synchronous DOM snapshot reader invoked repeatedly from the Service Worker polling loop.
 * Avoids background-tab setTimeout throttling and long-pending executeScript calls, and robustly
 * extracts Gemini/ChatGPT JSON responses even when thinking panels, trailing empty nodes, or
 * feedback widgets are present in the DOM.
 * Exported for jsdom unit testing.
 */
export function runDomReadWebSessionState(
  provider: 'chatgpt' | 'gemini',
  initialCount: number,
  initialLastText: string
): WebSessionPollState {
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');

  const href = window.location.href.toLowerCase();
  if (
    href.includes('/auth/login') ||
    href.includes('accounts.google.com') ||
    document.querySelector('a[href*="/auth/login"], button[data-testid="login-button"]')
  ) {
    return {
      ok: false,
      error: `${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'} のログインが切れました。再ログインしてからお試しください。`,
      responseText: '',
      hasCompleteJson: false,
      isGenerating: false,
      hasCompletionUi: false,
      responseCount: 0,
    };
  }

  const isVisible = (el: Element | null): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (!isJsdom) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  };

  const analyzeJson = (raw: string): { complete: boolean; hasScriptKeys: boolean } => {
    if (!raw || !raw.includes('{') || !raw.includes('}')) {
      return { complete: false, hasScriptKeys: false };
    }

    const tryParseObject = (candidate: string): { complete: boolean; hasScriptKeys: boolean } | null => {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const hasScriptKeys =
            Array.isArray(obj.chapters) ||
            Array.isArray(obj.turns) ||
            typeof obj.title === 'string';
          return { complete: true, hasScriptKeys };
        }
      } catch {
        // Not valid JSON yet
      }
      return null;
    };

    // 1. Check markdown ```json ... ``` blocks first
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fenceMatch: RegExpExecArray | null;
    while ((fenceMatch = fenceRegex.exec(raw)) !== null) {
      const res = tryParseObject(fenceMatch[1].trim());
      if (res) return res;
    }

    // 2. Scan for a balanced top-level JSON object starting from the first '{'
    const firstBrace = raw.indexOf('{');
    if (firstBrace < 0) return { complete: false, hasScriptKeys: false };

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = firstBrace; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = raw.slice(firstBrace, i + 1);
          const res = tryParseObject(slice);
          if (res) return res;
          break;
        }
      }
    }

    return { complete: false, hasScriptKeys: false };
  };

  const skipInsideSelector =
    'user-query, .query-text, [data-test-id*="user-query"], model-thoughts, .thoughts-container, .thought-content, [data-test-id*="thought"], .thinking-container';

  const extractCleanText = (node: Element): string => {
    const clone = node.cloneNode(true) as Element;
    const stripSelectors = [
      'model-thoughts',
      '.thoughts-container',
      '.thought-content',
      '[data-test-id*="thought"]',
      '.thinking-container',
      'message-actions',
      '.response-footer',
      '.actions-container',
      '.code-block-decoration',
      '.code-block-header',
      'button',
    ];
    for (const sel of stripSelectors) {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    return (clone.textContent || '').trim();
  };

  const candidates: string[] = [];
  const seenTexts = new Set<string>();
  const pushCandidate = (txt: string) => {
    const trimmed = txt.trim();
    if (!trimmed) return;
    if (seenTexts.has(trimmed)) return;
    seenTexts.add(trimmed);
    candidates.push(trimmed);
  };

  let responseCount = 0;
  let latestResponseContainer: Element | null = null;

  if (provider === 'chatgpt') {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    responseCount = nodes.length;
    latestResponseContainer = nodes[nodes.length - 1] || null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const codeBlocks = Array.from(node.querySelectorAll('pre code'));
      for (let j = codeBlocks.length - 1; j >= 0; j--) {
        pushCandidate(codeBlocks[j].textContent || '');
      }
      pushCandidate(node.textContent || '');
    }
  } else {
    const modelResponses = Array.from(document.querySelectorAll('model-response'));
    const allLegacy = Array.from(
      document.querySelectorAll('model-response, message-content, .model-response-text')
    );
    responseCount = allLegacy.length;
    latestResponseContainer = modelResponses[modelResponses.length - 1] || null;

    // Prioritize elements inside the latest model-response turns
    for (let i = modelResponses.length - 1; i >= 0; i--) {
      const mr = modelResponses[i];
      const codeBlocks = Array.from(mr.querySelectorAll('pre code, code-block code'));
      for (let j = codeBlocks.length - 1; j >= 0; j--) {
        if (codeBlocks[j].closest(skipInsideSelector)) continue;
        pushCandidate(codeBlocks[j].textContent || '');
      }
      const msgContents = Array.from(
        mr.querySelectorAll('message-content, .model-response-text, .markdown')
      );
      for (let j = msgContents.length - 1; j >= 0; j--) {
        if (msgContents[j].closest(skipInsideSelector)) continue;
        pushCandidate(extractCleanText(msgContents[j]));
      }
      pushCandidate(extractCleanText(mr));
    }

    // Fallback scan for Gemini layouts without <model-response> wrapper
    const fallbackNodes = Array.from(
      document.querySelectorAll(
        'message-content, .model-response-text, structured-content-container, response-container, pre code'
      )
    );
    for (let i = fallbackNodes.length - 1; i >= 0; i--) {
      const node = fallbackNodes[i];
      if (node.closest(skipInsideSelector)) continue;
      pushCandidate(extractCleanText(node));
    }
  }

  // Filter out stale pre-submit text if DOM node count hasn't increased
  const filteredCandidates = candidates.filter((txt) => {
    if (
      responseCount <= initialCount &&
      initialLastText &&
      txt.slice(0, 400) === initialLastText
    ) {
      return false;
    }
    return true;
  });

  // Pick best candidate:
  // 1) Complete parseable JSON with podcast script keys ("chapters" / "turns" / "title")
  // 2) Complete parseable JSON object
  // 3) Streaming JSON fragment containing '{' and '"' (longest)
  // 4) Latest non-empty response text
  let bestText = '';
  let bestComplete = false;
  let bestScore = -1;

  for (const txt of filteredCandidates) {
    const info = analyzeJson(txt);
    let score = 1;
    if (info.complete && info.hasScriptKeys) {
      score = 400 + Math.min(txt.length, 50000) / 100000;
    } else if (info.complete) {
      score = 300 + Math.min(txt.length, 50000) / 100000;
    } else if (txt.includes('{') && txt.includes('"')) {
      score = 200 + Math.min(txt.length, 50000) / 100000;
    } else {
      score = 100;
    }
    if (score > bestScore) {
      bestScore = score;
      bestText = txt;
      bestComplete = info.complete;
    }
  }

  // Detect whether generation is currently in progress
  let isGenerating = false;
  if (provider === 'chatgpt') {
    const stopEls = document.querySelectorAll(
      'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]'
    );
    for (const el of Array.from(stopEls)) {
      if (isVisible(el)) {
        isGenerating = true;
        break;
      }
    }
  } else {
    const stopSelectors = [
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop" i]',
      'button[mattooltip*="停止"]',
      'button[mattooltip*="Stop" i]',
      'button[data-test-id*="stop"]',
      '.stop-icon',
    ];
    for (const sel of stopSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        isGenerating = true;
        break;
      }
    }
    if (!isGenerating) {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const icon = btn.querySelector('mat-icon, .mat-icon, .google-symbols');
        const iconTxt = (icon?.textContent || '').trim().toLowerCase();
        if (iconTxt === 'stop' || iconTxt === 'stop_circle') {
          isGenerating = true;
          break;
        }
      }
    }
    if (!isGenerating && latestResponseContainer) {
      const busy = latestResponseContainer.querySelector('[aria-busy="true"]');
      if (busy && isVisible(busy)) {
        isGenerating = true;
      }
    }
  }

  // Detect post-generation completion action buttons (thumbs up/down, copy, etc.)
  let hasCompletionUi = false;
  if (provider === 'chatgpt') {
    const actionEls = document.querySelectorAll(
      'button[data-testid="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"]'
    );
    for (const el of Array.from(actionEls)) {
      if (isVisible(el)) {
        hasCompletionUi = true;
        break;
      }
    }
  } else {
    const scope: ParentNode = latestResponseContainer || document;
    const completionSelectors = [
      'message-actions button',
      '.response-footer button',
      'button[aria-label*="コピー"]',
      'button[aria-label*="Copy" i]',
      'button[aria-label*="高評価"]',
      'button[aria-label*="Good response" i]',
      'button[aria-label*="低評価"]',
      'button[aria-label*="Bad response" i]',
    ];
    for (const sel of completionSelectors) {
      const els = Array.from(scope.querySelectorAll(sel));
      if (els.some((el) => isVisible(el))) {
        hasCompletionUi = true;
        break;
      }
    }
  }

  return {
    ok: true,
    responseText: bestText,
    hasCompleteJson: bestComplete,
    isGenerating,
    hasCompletionUi,
    responseCount,
  };
}

/**
 * Self-contained DOM script injected into gemini.google.com right after a script is generated.
 * Ensures the target notebook (default: "agentcast") exists and adds the newly generated chat to it.
 * Exported for jsdom unit testing.
 */
export async function runDomOrganizeCurrentGeminiChatToNotebook(
  notebookName: string,
  chatIdHint = '',
  stepDelayMs = 350
): Promise<GeminiNotebookCurrentChatResult> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
  const d = (ms: number) => (isJsdom ? Math.min(ms, 20) : ms);

  const normalizeName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const targetNorm = normalizeName(notebookName || 'agentcast');

  const isVisible = (el: Element | null): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (!isJsdom) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  };

  const getCleanText = (el: Element | null): string => {
    if (!el) return '';
    const skipSelector =
      'mat-icon, .mat-icon, .google-symbols, .material-symbols-outlined, .material-icons, svg, [aria-hidden="true"]';
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent || '';
        if (t.trim()) parts.push(t.trim());
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;
        if (elem.matches(skipSelector)) return;
        for (const child of Array.from(elem.childNodes)) {
          walk(child);
        }
      }
    };
    walk(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  const setInputValue = (input: HTMLElement, value: string) => {
    input.focus();
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      const proto =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.textContent = value;
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      );
    }
  };

  const findSidebarRoot = (): Element => {
    const candidates = [
      'bard-sidenav',
      'side-navigation-content',
      '[data-test-id="side-nav-container"]',
      'nav',
      'aside',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  };

  const findHeadingElement = (root: Element, pattern: RegExp): Element | null => {
    const nodes = Array.from(root.querySelectorAll('h1, h2, h3, h4, div, span, p, button'));
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (el.children.length > 2) continue;
      const txt = getCleanText(el);
      if (txt && txt.length <= 40 && pattern.test(txt)) {
        return el;
      }
    }
    return null;
  };

  const isAfterInDom = (a: Node, b: Node): boolean =>
    Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);

  const isBeforeInDom = (a: Node, b: Node): boolean =>
    Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);

  const ensureSidebarOpen = async (): Promise<Element> => {
    let sidebar = findSidebarRoot();
    const hasSidebarMarkers = () => {
      const text = sidebar.textContent || '';
      return (
        /ノートブック|notebooks/i.test(text) ||
        /チャットを新規作成|new chat/i.test(text) ||
        Boolean(sidebar.querySelector('a[href*="/app/"], [data-test-id="conversation"]'))
      );
    };

    if (!isVisible(sidebar) || !hasSidebarMarkers()) {
      const menuBtnSelectors = [
        'button[data-test-id="side-nav-menu-button"]',
        'button[aria-label*="メイン メニュー"]',
        'button[aria-label*="Main menu" i]',
        'button[aria-label*="メニュー"]',
        'button[aria-label*="menu" i]',
      ];
      for (const sel of menuBtnSelectors) {
        const btn = document.querySelector<HTMLElement>(sel);
        if (btn && isVisible(btn)) {
          btn.click();
          await wait(d(600));
          sidebar = findSidebarRoot();
          break;
        }
      }
    }
    return sidebar;
  };

  const findCreateNotebookButton = (sidebar: Element): HTMLElement | null => {
    const createRegex =
      /ノートブックを新規作成|新しいノートブック|新規ノートブック|create (a )?new notebook|new notebook|create notebook/i;
    const candidates = Array.from(
      sidebar.querySelectorAll('button, a, [role="button"], [role="listitem"]')
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = `${getCleanText(el)} ${el.getAttribute('aria-label') || ''}`.trim();
      if (createRegex.test(label)) return el;
    }
    return null;
  };

  const findNotebookSectionItems = (sidebar: Element): HTMLElement[] => {
    const createBtn = findCreateNotebookButton(sidebar);
    const nbHeading = findHeadingElement(sidebar, /^(ノートブック|notebooks?)$/i);
    const allHeading = findHeadingElement(sidebar, /^(すべて|recent|all|チャット|chats?)$/i);
    const anchorStart = createBtn || nbHeading;

    const results: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    const candidates = Array.from(
      sidebar.querySelectorAll('a, button, [role="listitem"], [role="button"], [role="link"], [role="treeitem"]')
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (el === createBtn) continue;
      if (el.closest('button') && el.closest('button') !== el) continue;
      const href = el.getAttribute('href') || '';
      const testId = el.getAttribute('data-test-id') || '';
      const isExplicitNotebook = /\/notebook\//i.test(href) || /notebook/i.test(testId);
      const isInSection =
        anchorStart != null &&
        isAfterInDom(el, anchorStart) &&
        (!allHeading || isBeforeInDom(el, allHeading));

      if (!isExplicitNotebook && !isInSection) continue;
      if (allHeading && isAfterInDom(el, allHeading)) continue;

      const txt = getCleanText(el);
      if (!txt) continue;
      if (/ノートブックを新規作成|new notebook|create notebook/i.test(txt)) continue;
      // Ignore pure options menu buttons inside notebook rows
      if (/^(オプション|その他|more|options|actions)$/i.test(txt)) continue;
      const aria = el.getAttribute('aria-label') || '';
      if (/オプション|more options|actions menu/i.test(aria) && txt.length < 3) continue;

      if (!seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    }
    return results;
  };

  const findNotebookByName = (sidebar: Element, nameNorm: string): HTMLElement | null => {
    const items = findNotebookSectionItems(sidebar);
    for (const item of items) {
      if (normalizeName(getCleanText(item)) === nameNorm) return item;
    }
    return null;
  };

  const findRowOptionsButton = (row: HTMLElement): HTMLElement | null => {
    const containers: Element[] = [row];
    if (row.parentElement) containers.push(row.parentElement);

    const selectors = [
      'button[data-test-id*="actions-menu"]',
      'button[aria-label*="オプション"]',
      'button[aria-label*="その他"]',
      'button[aria-label*="メニュー"]',
      'button[aria-label*="More" i]',
      'button[aria-label*="Options" i]',
      'button[aria-label*="Actions" i]',
    ];
    for (const container of containers) {
      for (const sel of selectors) {
        const btn = container.querySelector<HTMLElement>(sel);
        if (btn && btn !== row && isVisible(btn)) return btn;
      }
      const buttons = Array.from(container.querySelectorAll<HTMLElement>('button'));
      for (const btn of buttons) {
        if (btn === row || !isVisible(btn)) continue;
        const iconText = (btn.textContent || '').trim().toLowerCase();
        if (iconText.includes('more_vert') || iconText.includes('more_horiz')) {
          return btn;
        }
      }
    }
    return null;
  };

  const getActiveOverlays = (): HTMLElement[] => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menu"], [role="dialog"], mat-dialog-container, .mat-mdc-menu-panel, .cdk-overlay-pane'
      )
    );
    return els.filter((el) => isVisible(el) && (el.textContent || '').trim().length > 0);
  };

  const closeOverlays = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await wait(d(150));
  };

  const openItemContextMenu = async (row: HTMLElement): Promise<HTMLElement | null> => {
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
    for (const evType of ['pointerenter', 'mouseenter', 'mouseover', 'pointermove']) {
      row.dispatchEvent(new MouseEvent(evType, { bubbles: true }));
      row.parentElement?.dispatchEvent(new MouseEvent(evType, { bubbles: true }));
    }
    await wait(d(180));

    const optBtn = findRowOptionsButton(row);
    if (!optBtn) return null;
    optBtn.click();
    await wait(d(stepDelayMs));

    const overlays = getActiveOverlays();
    return overlays[overlays.length - 1] || null;
  };

  const clickOverlayConfirmButton = async (
    pattern = /^(作成|保存|完了|追加|名前を変更|適用|ok|create|save|done|add|rename|apply)$/i
  ): Promise<boolean> => {
    const overlays = getActiveOverlays();
    for (let i = overlays.length - 1; i >= 0; i--) {
      const buttons = Array.from(overlays[i].querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        if (btn instanceof HTMLButtonElement && btn.disabled) continue;
        if (btn.getAttribute('aria-disabled') === 'true') continue;
        const txt = getCleanText(btn);
        if (pattern.test(txt)) {
          btn.click();
          await wait(d(stepDelayMs));
          return true;
        }
      }
    }
    return false;
  };

  const ensureNotebookExists = async (): Promise<{ ok: boolean; created: boolean; error?: string }> => {
    let sidebar = await ensureSidebarOpen();
    if (findNotebookByName(sidebar, targetNorm)) {
      return { ok: true, created: false };
    }

    const beforeItems = new Set<HTMLElement>(findNotebookSectionItems(sidebar));
    const beforeHrefs = new Set(
      Array.from(beforeItems)
        .map((el) => el.getAttribute('href') || '')
        .filter(Boolean)
    );

    const createBtn = findCreateNotebookButton(sidebar);
    if (!createBtn) {
      return { ok: false, created: false, error: '「ノートブックを新規作成」ボタンが見つかりませんでした。' };
    }

    createBtn.click();
    await wait(d(900));

    // Strategy 1: Modal/dialog opened with a text input
    const overlays = getActiveOverlays();
    for (let i = overlays.length - 1; i >= 0; i--) {
      const input = overlays[i].querySelector<HTMLElement>(
        'input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
      );
      if (input && isVisible(input)) {
        setInputValue(input, notebookName);
        await wait(d(200));
        const clicked = await clickOverlayConfirmButton();
        if (!clicked) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          await wait(d(500));
        }
        sidebar = await ensureSidebarOpen();
        if (findNotebookByName(sidebar, targetNorm)) {
          return { ok: true, created: true };
        }
      }
    }

    // Strategy 2: Navigated to new notebook page with inline editable title (e.g. "Untitled notebook")
    const mainRoot = document.querySelector('main') || document.body;
    const inlineInputs = Array.from(
      mainRoot.querySelectorAll<HTMLElement>('input[type="text"], input:not([type]), [contenteditable="true"]')
    ).filter((el) => !sidebar.contains(el) && isVisible(el));
    for (const inp of inlineInputs) {
      const val =
        inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement
          ? inp.value
          : getCleanText(inp);
      if (!val || /untitled notebook|無題のノートブック/i.test(val)) {
        setInputValue(inp, notebookName);
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        inp.blur();
        await wait(d(700));
        sidebar = await ensureSidebarOpen();
        if (findNotebookByName(sidebar, targetNorm)) {
          return { ok: true, created: true };
        }
      }
    }

    // Strategy 3: Newly added "Untitled notebook" / "無題のノートブック" item in sidebar -> Rename via context menu
    sidebar = await ensureSidebarOpen();
    const afterItems = findNotebookSectionItems(sidebar);
    const newlyAdded = afterItems.find((el) => {
      const href = el.getAttribute('href') || '';
      if (href && beforeHrefs.has(href)) return false;
      return !beforeItems.has(el);
    });
    if (newlyAdded) {
      const menu = await openItemContextMenu(newlyAdded);
      if (menu) {
        const renameItem = Array.from(
          menu.querySelectorAll<HTMLElement>('[role="menuitem"], button, a, li')
        ).find((el) => isVisible(el) && /名前を変更|rename/i.test(getCleanText(el)));
        if (renameItem) {
          renameItem.click();
          await wait(d(stepDelayMs));
          const renameOverlays = getActiveOverlays();
          for (let i = renameOverlays.length - 1; i >= 0; i--) {
            const inp = renameOverlays[i].querySelector<HTMLElement>(
              'input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
            );
            if (inp && isVisible(inp)) {
              setInputValue(inp, notebookName);
              await wait(d(200));
              const confirmed = await clickOverlayConfirmButton();
              if (!confirmed) {
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                await wait(d(500));
              }
              break;
            }
          }
        }
      }
      sidebar = await ensureSidebarOpen();
      if (findNotebookByName(sidebar, targetNorm)) {
        return { ok: true, created: true };
      }
    }

    return {
      ok: false,
      created: false,
      error: `「${notebookName}」ノートブックの作成を確認できませんでした。`,
    };
  };

  const addChatRowToNotebook = async (row: HTMLElement): Promise<'added' | 'already' | 'failed'> => {
    const menu = await openItemContextMenu(row);
    if (!menu) return 'failed';

    const menuItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menu"] [role="menuitem"], [role="menu"] button, .mat-mdc-menu-panel button, .cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button'
      )
    );
    const addMenuItem = menuItems.find(
      (el) =>
        isVisible(el) &&
        /ノートブックに追加|add to notebook/i.test(getCleanText(el)) &&
        !/削除|remove/i.test(getCleanText(el))
    );
    if (!addMenuItem) {
      await closeOverlays();
      return 'failed';
    }

    addMenuItem.click();
    await wait(d(stepDelayMs + 100));

    const pickerOverlays = getActiveOverlays();
    let targetOption: HTMLElement | null = null;
    for (let i = pickerOverlays.length - 1; i >= 0; i--) {
      const options = Array.from(
        pickerOverlays[i].querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="checkbox"], button, label, li, .mat-mdc-list-item'
        )
      );
      for (const opt of options) {
        if (!isVisible(opt)) continue;
        if (normalizeName(getCleanText(opt)) === targetNorm) {
          targetOption = opt;
          break;
        }
      }
      if (targetOption) break;
    }

    if (!targetOption) {
      await closeOverlays();
      return 'failed';
    }

    const checkbox = targetOption.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const alreadyChecked =
      targetOption.getAttribute('aria-checked') === 'true' ||
      targetOption.getAttribute('aria-selected') === 'true' ||
      Boolean(checkbox?.checked);

    if (alreadyChecked) {
      await closeOverlays();
      return 'already';
    }

    targetOption.click();
    await wait(d(stepDelayMs));

    // If a confirmation dialog stays open, click its confirm button
    if (getActiveOverlays().length > 0) {
      await clickOverlayConfirmButton(/^(追加|保存|完了|適用|ok|add|save|done|apply)$/i);
    }
    await closeOverlays();
    return 'added';
  };

  const findChatRowsInAllSection = (sidebar: Element): HTMLElement[] => {
    const allHeading = findHeadingElement(sidebar, /^(すべて|recent|all|チャット|chats?)$/i);
    const results: HTMLElement[] = [];
    const seen = new Set<string>();

    const candidates = Array.from(
      sidebar.querySelectorAll<HTMLElement>(
        'a[href*="/app/"], [data-test-id="conversation"], .conversation'
      )
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (allHeading && isBeforeInDom(el, allHeading)) continue;
      const href = el.getAttribute('href') || '';
      if (href && /\/app\/?$/.test(href)) continue;
      const key = href || getCleanText(el);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(el);
    }

    if (results.length > 0) return results;

    if (allHeading) {
      const fallbackItems = Array.from(
        sidebar.querySelectorAll<HTMLElement>('[role="listitem"], a, button')
      );
      for (const el of fallbackItems) {
        if (!isVisible(el) || !isAfterInDom(el, allHeading)) continue;
        const txt = getCleanText(el);
        if (!txt || /^(もっと見る|さらに表示|show more|load more|設定とヘルプ|settings)/i.test(txt)) {
          continue;
        }
        const aria = el.getAttribute('aria-label') || '';
        if (/オプション|more options|actions menu/i.test(aria)) continue;
        if (seen.has(txt)) continue;
        seen.add(txt);
        results.push(el);
      }
    }
    return results;
  };

  // --- Main flow for current chat ---
  const urlMatch = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
  const chatId = chatIdHint || urlMatch?.[1] || '';

  const nbRes = await ensureNotebookExists();
  if (!nbRes.ok) {
    return {
      ok: false,
      notebookName,
      createdNotebook: nbRes.created,
      status: 'failed',
      chatId,
      error: nbRes.error,
    };
  }

  const sidebar = await ensureSidebarOpen();
  const rows = findChatRowsInAllSection(sidebar);
  let targetRow: HTMLElement | null = null;
  if (chatId) {
    targetRow =
      rows.find((r) => (r.getAttribute('href') || '').includes(chatId)) ||
      sidebar.querySelector<HTMLElement>(`a[href*="${chatId}"]`);
  }
  if (!targetRow) {
    targetRow =
      rows.find(
        (r) =>
          r.getAttribute('aria-current') === 'page' ||
          r.classList.contains('selected') ||
          r.classList.contains('active')
      ) ||
      rows[0] ||
      null;
  }

  if (!targetRow) {
    return {
      ok: false,
      notebookName,
      createdNotebook: nbRes.created,
      status: 'failed',
      chatId,
      error: 'サイドバーに対象の会話が見つかりませんでした。',
    };
  }

  const addStatus = await addChatRowToNotebook(targetRow);
  return {
    ok: addStatus !== 'failed',
    notebookName,
    createdNotebook: nbRes.created,
    status: addStatus,
    chatId,
    error: addStatus === 'failed' ? `「${notebookName}」ノートブックへの追加に失敗しました。` : undefined,
  };
}

/**
 * Self-contained DOM script injected into gemini.google.com to scan all past chats in "すべて",
 * identify agentCast podcast scripts by inspecting conversation content, and add them to the target notebook.
 * Exported for jsdom unit testing.
 */
export async function runDomOrganizePastGeminiScriptsToNotebook(
  notebookName: string,
  maxChats = 200
): Promise<GeminiNotebookOrganizeResult> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isJsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');
  const d = (ms: number) => (isJsdom ? Math.min(ms, 15) : ms);

  const normalizeName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const targetNorm = normalizeName(notebookName || 'agentcast');

  const isScriptText = (text: string): boolean => {
    if (!text) return false;
    if (
      text.includes('ポッドキャスト番組の構成作家') ||
      text.includes('ユーザーのフォロー中SNS・購読サイトから集めた未読アイテム一覧') ||
      text.includes('ラジオ番組台本をJSON形式で作成してください')
    ) {
      return true;
    }
    return (
      text.includes('"chapters"') &&
      text.includes('"turns"') &&
      (text.includes('"HostA"') || text.includes('"spokenText"') || text.includes('"sourceIds"'))
    );
  };

  const reportProgress = (
    scanned: number,
    total: number,
    added: number,
    already: number,
    skipped: number,
    stage: string
  ) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        void chrome.runtime.sendMessage({
          type: 'GEMINI_NOTEBOOK_ORGANIZE_PROGRESS',
          scanned,
          total,
          added,
          already,
          skipped,
          stage,
        });
      }
    } catch {
      // Best-effort progress updates
    }
  };

  // Detect sign-in state
  const hrefLower = window.location.href.toLowerCase();
  if (hrefLower.includes('accounts.google.com') || hrefLower.includes('/auth/login')) {
    return {
      ok: false,
      notebookName,
      createdNotebook: false,
      totalScanned: 0,
      addedCount: 0,
      alreadyCount: 0,
      skippedCount: 0,
      failedCount: 0,
      error: 'Gemini にブラウザでログインしてから再実行してください。',
    };
  }

  const isVisible = (el: Element | null): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (!isJsdom) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  };

  const getCleanText = (el: Element | null): string => {
    if (!el) return '';
    const skipSelector =
      'mat-icon, .mat-icon, .google-symbols, .material-symbols-outlined, .material-icons, svg, [aria-hidden="true"]';
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent || '';
        if (t.trim()) parts.push(t.trim());
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;
        if (elem.matches(skipSelector)) return;
        for (const child of Array.from(elem.childNodes)) {
          walk(child);
        }
      }
    };
    walk(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  const setInputValue = (input: HTMLElement, value: string) => {
    input.focus();
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      const proto =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      input.textContent = value;
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
      );
    }
  };

  const findSidebarRoot = (): Element => {
    const candidates = [
      'bard-sidenav',
      'side-navigation-content',
      '[data-test-id="side-nav-container"]',
      'nav',
      'aside',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  };

  const findHeadingElement = (root: Element, pattern: RegExp): Element | null => {
    const nodes = Array.from(root.querySelectorAll('h1, h2, h3, h4, div, span, p, button'));
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      if (el.children.length > 2) continue;
      const txt = getCleanText(el);
      if (txt && txt.length <= 40 && pattern.test(txt)) {
        return el;
      }
    }
    return null;
  };

  const isAfterInDom = (a: Node, b: Node): boolean =>
    Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);

  const isBeforeInDom = (a: Node, b: Node): boolean =>
    Boolean(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);

  const ensureSidebarOpen = async (): Promise<Element> => {
    let sidebar = findSidebarRoot();
    const hasSidebarMarkers = () => {
      const text = sidebar.textContent || '';
      return (
        /ノートブック|notebooks/i.test(text) ||
        /チャットを新規作成|new chat/i.test(text) ||
        Boolean(sidebar.querySelector('a[href*="/app/"], [data-test-id="conversation"]'))
      );
    };

    if (!isVisible(sidebar) || !hasSidebarMarkers()) {
      const menuBtnSelectors = [
        'button[data-test-id="side-nav-menu-button"]',
        'button[aria-label*="メイン メニュー"]',
        'button[aria-label*="Main menu" i]',
        'button[aria-label*="メニュー"]',
        'button[aria-label*="menu" i]',
      ];
      for (const sel of menuBtnSelectors) {
        const btn = document.querySelector<HTMLElement>(sel);
        if (btn && isVisible(btn)) {
          btn.click();
          await wait(d(600));
          sidebar = findSidebarRoot();
          break;
        }
      }
    }
    return sidebar;
  };

  const findCreateNotebookButton = (sidebar: Element): HTMLElement | null => {
    const createRegex =
      /ノートブックを新規作成|新しいノートブック|新規ノートブック|create (a )?new notebook|new notebook|create notebook/i;
    const candidates = Array.from(
      sidebar.querySelectorAll('button, a, [role="button"], [role="listitem"]')
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const label = `${getCleanText(el)} ${el.getAttribute('aria-label') || ''}`.trim();
      if (createRegex.test(label)) return el;
    }
    return null;
  };

  const findNotebookSectionItems = (sidebar: Element): HTMLElement[] => {
    const createBtn = findCreateNotebookButton(sidebar);
    const nbHeading = findHeadingElement(sidebar, /^(ノートブック|notebooks?)$/i);
    const allHeading = findHeadingElement(sidebar, /^(すべて|recent|all|チャット|chats?)$/i);
    const anchorStart = createBtn || nbHeading;

    const results: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();

    const candidates = Array.from(
      sidebar.querySelectorAll('a, button, [role="listitem"], [role="button"], [role="link"], [role="treeitem"]')
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (el === createBtn) continue;
      if (el.closest('button') && el.closest('button') !== el) continue;
      const href = el.getAttribute('href') || '';
      const testId = el.getAttribute('data-test-id') || '';
      const isExplicitNotebook = /\/notebook\//i.test(href) || /notebook/i.test(testId);
      const isInSection =
        anchorStart != null &&
        isAfterInDom(el, anchorStart) &&
        (!allHeading || isBeforeInDom(el, allHeading));

      if (!isExplicitNotebook && !isInSection) continue;
      if (allHeading && isAfterInDom(el, allHeading)) continue;

      const txt = getCleanText(el);
      if (!txt) continue;
      if (/ノートブックを新規作成|new notebook|create notebook/i.test(txt)) continue;
      if (/^(オプション|その他|more|options|actions)$/i.test(txt)) continue;
      const aria = el.getAttribute('aria-label') || '';
      if (/オプション|more options|actions menu/i.test(aria) && txt.length < 3) continue;

      if (!seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    }
    return results;
  };

  const findNotebookByName = (sidebar: Element, nameNorm: string): HTMLElement | null => {
    const items = findNotebookSectionItems(sidebar);
    for (const item of items) {
      if (normalizeName(getCleanText(item)) === nameNorm) return item;
    }
    return null;
  };

  const findRowOptionsButton = (row: HTMLElement): HTMLElement | null => {
    const containers: Element[] = [row];
    if (row.parentElement) containers.push(row.parentElement);
    const selectors = [
      'button[data-test-id*="actions-menu"]',
      'button[aria-label*="オプション"]',
      'button[aria-label*="その他"]',
      'button[aria-label*="メニュー"]',
      'button[aria-label*="More" i]',
      'button[aria-label*="Options" i]',
      'button[aria-label*="Actions" i]',
    ];
    for (const container of containers) {
      for (const sel of selectors) {
        const btn = container.querySelector<HTMLElement>(sel);
        if (btn && btn !== row && isVisible(btn)) return btn;
      }
      const buttons = Array.from(container.querySelectorAll<HTMLElement>('button'));
      for (const btn of buttons) {
        if (btn === row || !isVisible(btn)) continue;
        const iconText = (btn.textContent || '').trim().toLowerCase();
        if (iconText.includes('more_vert') || iconText.includes('more_horiz')) {
          return btn;
        }
      }
    }
    return null;
  };

  const getActiveOverlays = (): HTMLElement[] => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menu"], [role="dialog"], mat-dialog-container, .mat-mdc-menu-panel, .cdk-overlay-pane'
      )
    );
    return els.filter((el) => isVisible(el) && (el.textContent || '').trim().length > 0);
  };

  const closeOverlays = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await wait(d(150));
  };

  const openItemContextMenu = async (row: HTMLElement): Promise<HTMLElement | null> => {
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
    for (const evType of ['pointerenter', 'mouseenter', 'mouseover', 'pointermove']) {
      row.dispatchEvent(new MouseEvent(evType, { bubbles: true }));
      row.parentElement?.dispatchEvent(new MouseEvent(evType, { bubbles: true }));
    }
    await wait(d(160));

    const optBtn = findRowOptionsButton(row);
    if (!optBtn) return null;
    optBtn.click();
    await wait(d(320));

    const overlays = getActiveOverlays();
    return overlays[overlays.length - 1] || null;
  };

  const clickOverlayConfirmButton = async (
    pattern = /^(作成|保存|完了|追加|名前を変更|適用|ok|create|save|done|add|rename|apply)$/i
  ): Promise<boolean> => {
    const overlays = getActiveOverlays();
    for (let i = overlays.length - 1; i >= 0; i--) {
      const buttons = Array.from(overlays[i].querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        if (btn instanceof HTMLButtonElement && btn.disabled) continue;
        if (btn.getAttribute('aria-disabled') === 'true') continue;
        const txt = getCleanText(btn);
        if (pattern.test(txt)) {
          btn.click();
          await wait(d(350));
          return true;
        }
      }
    }
    return false;
  };

  const ensureNotebookExists = async (): Promise<{ ok: boolean; created: boolean; error?: string }> => {
    let sidebar = await ensureSidebarOpen();
    if (findNotebookByName(sidebar, targetNorm)) {
      return { ok: true, created: false };
    }

    const beforeItems = new Set<HTMLElement>(findNotebookSectionItems(sidebar));
    const beforeHrefs = new Set(
      Array.from(beforeItems)
        .map((el) => el.getAttribute('href') || '')
        .filter(Boolean)
    );

    const createBtn = findCreateNotebookButton(sidebar);
    if (!createBtn) {
      return { ok: false, created: false, error: '「ノートブックを新規作成」ボタンが見つかりませんでした。' };
    }

    createBtn.click();
    await wait(d(900));

    // Strategy 1: Modal/dialog
    const overlays = getActiveOverlays();
    for (let i = overlays.length - 1; i >= 0; i--) {
      const input = overlays[i].querySelector<HTMLElement>(
        'input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
      );
      if (input && isVisible(input)) {
        setInputValue(input, notebookName);
        await wait(d(200));
        const clicked = await clickOverlayConfirmButton();
        if (!clicked) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          await wait(d(500));
        }
        sidebar = await ensureSidebarOpen();
        if (findNotebookByName(sidebar, targetNorm)) {
          return { ok: true, created: true };
        }
      }
    }

    // Strategy 2: Inline editable title
    const mainRoot = document.querySelector('main') || document.body;
    const inlineInputs = Array.from(
      mainRoot.querySelectorAll<HTMLElement>('input[type="text"], input:not([type]), [contenteditable="true"]')
    ).filter((el) => !sidebar.contains(el) && isVisible(el));
    for (const inp of inlineInputs) {
      const val =
        inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement
          ? inp.value
          : getCleanText(inp);
      if (!val || /untitled notebook|無題のノートブック/i.test(val)) {
        setInputValue(inp, notebookName);
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        inp.blur();
        await wait(d(700));
        sidebar = await ensureSidebarOpen();
        if (findNotebookByName(sidebar, targetNorm)) {
          return { ok: true, created: true };
        }
      }
    }

    // Strategy 3: Newly added sidebar item rename
    sidebar = await ensureSidebarOpen();
    const afterItems = findNotebookSectionItems(sidebar);
    const newlyAdded = afterItems.find((el) => {
      const href = el.getAttribute('href') || '';
      if (href && beforeHrefs.has(href)) return false;
      return !beforeItems.has(el);
    });
    if (newlyAdded) {
      const menu = await openItemContextMenu(newlyAdded);
      if (menu) {
        const renameItem = Array.from(
          menu.querySelectorAll<HTMLElement>('[role="menuitem"], button, a, li')
        ).find((el) => isVisible(el) && /名前を変更|rename/i.test(getCleanText(el)));
        if (renameItem) {
          renameItem.click();
          await wait(d(350));
          const renameOverlays = getActiveOverlays();
          for (let i = renameOverlays.length - 1; i >= 0; i--) {
            const inp = renameOverlays[i].querySelector<HTMLElement>(
              'input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
            );
            if (inp && isVisible(inp)) {
              setInputValue(inp, notebookName);
              await wait(d(200));
              const confirmed = await clickOverlayConfirmButton();
              if (!confirmed) {
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                await wait(d(500));
              }
              break;
            }
          }
        }
      }
      sidebar = await ensureSidebarOpen();
      if (findNotebookByName(sidebar, targetNorm)) {
        return { ok: true, created: true };
      }
    }

    return {
      ok: false,
      created: false,
      error: `「${notebookName}」ノートブックの作成を確認できませんでした。`,
    };
  };

  const addChatRowToNotebook = async (row: HTMLElement): Promise<'added' | 'already' | 'failed'> => {
    const menu = await openItemContextMenu(row);
    if (!menu) return 'failed';

    const menuItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="menu"] [role="menuitem"], [role="menu"] button, .mat-mdc-menu-panel button, .cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button'
      )
    );
    const addMenuItem = menuItems.find(
      (el) =>
        isVisible(el) &&
        /ノートブックに追加|add to notebook/i.test(getCleanText(el)) &&
        !/削除|remove/i.test(getCleanText(el))
    );
    if (!addMenuItem) {
      await closeOverlays();
      return 'failed';
    }

    addMenuItem.click();
    await wait(d(420));

    const pickerOverlays = getActiveOverlays();
    let targetOption: HTMLElement | null = null;
    for (let i = pickerOverlays.length - 1; i >= 0; i--) {
      const options = Array.from(
        pickerOverlays[i].querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="checkbox"], button, label, li, .mat-mdc-list-item'
        )
      );
      for (const opt of options) {
        if (!isVisible(opt)) continue;
        if (normalizeName(getCleanText(opt)) === targetNorm) {
          targetOption = opt;
          break;
        }
      }
      if (targetOption) break;
    }

    if (!targetOption) {
      await closeOverlays();
      return 'failed';
    }

    const checkbox = targetOption.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const alreadyChecked =
      targetOption.getAttribute('aria-checked') === 'true' ||
      targetOption.getAttribute('aria-selected') === 'true' ||
      Boolean(checkbox?.checked);

    if (alreadyChecked) {
      await closeOverlays();
      return 'already';
    }

    targetOption.click();
    await wait(d(350));

    if (getActiveOverlays().length > 0) {
      await clickOverlayConfirmButton(/^(追加|保存|完了|適用|ok|add|save|done|apply)$/i);
    }
    await closeOverlays();
    return 'added';
  };

  const findChatRowsInAllSection = (sidebar: Element): HTMLElement[] => {
    const allHeading = findHeadingElement(sidebar, /^(すべて|recent|all|チャット|chats?)$/i);
    const results: HTMLElement[] = [];
    const seen = new Set<string>();

    const candidates = Array.from(
      sidebar.querySelectorAll<HTMLElement>(
        'a[href*="/app/"], [data-test-id="conversation"], .conversation'
      )
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (allHeading && isBeforeInDom(el, allHeading)) continue;
      const href = el.getAttribute('href') || '';
      if (href && /\/app\/?$/.test(href)) continue;
      const key = href || getCleanText(el);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(el);
    }

    if (results.length > 0) return results;

    if (allHeading) {
      const fallbackItems = Array.from(
        sidebar.querySelectorAll<HTMLElement>('[role="listitem"], a, button')
      );
      for (const el of fallbackItems) {
        if (!isVisible(el) || !isAfterInDom(el, allHeading)) continue;
        const txt = getCleanText(el);
        if (!txt || /^(もっと見る|さらに表示|show more|load more|設定とヘルプ|settings)/i.test(txt)) {
          continue;
        }
        const aria = el.getAttribute('aria-label') || '';
        if (/オプション|more options|actions menu/i.test(aria)) continue;
        if (seen.has(txt)) continue;
        seen.add(txt);
        results.push(el);
      }
    }
    return results;
  };

  const readConversationText = (): string => {
    const selectors = [
      'user-query',
      '.query-text',
      '[data-test-id*="user-query"]',
      'message-content',
      'model-response',
      '.model-response-text',
    ];
    const parts: string[] = [];
    for (const sel of selectors) {
      for (const node of Array.from(document.querySelectorAll(sel))) {
        const txt = (node.textContent || '').trim();
        if (txt) parts.push(txt);
      }
    }
    if (parts.length > 0) return parts.join('\n');
    const mainEl = document.querySelector('main');
    return (mainEl?.textContent || '').trim();
  };

  // --- Step 1: Ensure notebook exists ---
  reportProgress(0, 0, 0, 0, 0, `「${notebookName}」ノートブックを確認中...`);
  const nbRes = await ensureNotebookExists();
  if (!nbRes.ok) {
    return {
      ok: false,
      notebookName,
      createdNotebook: nbRes.created,
      totalScanned: 0,
      addedCount: 0,
      alreadyCount: 0,
      skippedCount: 0,
      failedCount: 0,
      error: nbRes.error,
    };
  }

  // --- Step 2: Best-effort collect chats already inside target notebook ---
  const alreadyInNotebookIds = new Set<string>();
  let sidebar = await ensureSidebarOpen();
  const nbEl = findNotebookByName(sidebar, targetNorm);
  if (nbEl && !isJsdom) {
    nbEl.click();
    await wait(d(900));
    const mainArea = document.querySelector('main') || document.body;
    for (const link of Array.from(mainArea.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]'))) {
      if (sidebar.contains(link)) continue;
      const m = (link.getAttribute('href') || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (m?.[1]) alreadyInNotebookIds.add(m[1]);
    }
  }

  // --- Step 3: Scroll sidebar to load past chats ---
  sidebar = await ensureSidebarOpen();
  reportProgress(0, 0, 0, 0, 0, '過去の会話一覧を読み込み中...');

  const findScrollableContainer = (root: Element): HTMLElement | null => {
    const preferred = root.querySelector<HTMLElement>(
      'infinite-scroller, .overflow-container, .conversations-container, bard-sidenav-content'
    );
    if (preferred && preferred.scrollHeight > preferred.clientHeight) return preferred;
    const rows = findChatRowsInAllSection(root);
    let cur: HTMLElement | null = rows[0]?.parentElement || null;
    while (cur && cur !== document.body) {
      if (cur.scrollHeight > cur.clientHeight + 20) return cur;
      cur = cur.parentElement;
    }
    return null;
  };

  let prevRowCount = 0;
  let stagnantRounds = 0;
  for (let round = 0; round < 20; round++) {
    const showMoreBtn = Array.from(sidebar.querySelectorAll<HTMLElement>('button, a')).find(
      (el) => isVisible(el) && /^(もっと見る|さらに表示|show more|load more)$/i.test(getCleanText(el))
    );
    if (showMoreBtn) {
      showMoreBtn.click();
      await wait(d(600));
    }
    const scroller = findScrollableContainer(sidebar);
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      await wait(d(650));
    }
    const count = findChatRowsInAllSection(sidebar).length;
    if (count >= maxChats) break;
    if (count === prevRowCount) {
      stagnantRounds++;
      if (stagnantRounds >= 2) break;
    } else {
      prevRowCount = count;
      stagnantRounds = 0;
    }
  }

  const scroller = findScrollableContainer(sidebar);
  if (scroller) scroller.scrollTop = 0;

  // Snapshot targets by stable key (href or title + index)
  const initialRows = findChatRowsInAllSection(sidebar).slice(0, maxChats);
  const targets = initialRows.map((row, idx) => {
    const href = row.getAttribute('href') || '';
    const m = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
    return {
      idx,
      href,
      chatId: m?.[1] || '',
      title: getCleanText(row),
    };
  });

  let addedCount = 0;
  let alreadyCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let totalScanned = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    totalScanned++;
    reportProgress(
      totalScanned,
      targets.length,
      addedCount,
      alreadyCount,
      skippedCount,
      `過去の会話をスキャン中 (${totalScanned}/${targets.length}件・追加${addedCount}件)...`
    );

    if (target.chatId && alreadyInNotebookIds.has(target.chatId)) {
      alreadyCount++;
      continue;
    }

    sidebar = await ensureSidebarOpen();
    const currentRows = findChatRowsInAllSection(sidebar);
    const locateRow = (): HTMLElement | null => {
      if (target.chatId) {
        const byId = currentRows.find((r) => (r.getAttribute('href') || '').includes(target.chatId));
        if (byId) return byId;
      }
      if (target.href) {
        const byHref = currentRows.find((r) => r.getAttribute('href') === target.href);
        if (byHref) return byHref;
      }
      const byTitle = currentRows.find((r) => getCleanText(r) === target.title);
      return byTitle || currentRows[target.idx] || null;
    };

    const rowToOpen = locateRow();
    if (!rowToOpen) {
      skippedCount++;
      continue;
    }

    const prevText = readConversationText().slice(0, 200);
    const prevHref = window.location.href;
    rowToOpen.click();

    // Wait for conversation content or URL to update
    for (let tick = 0; tick < 12; tick++) {
      await wait(d(280));
      const nowText = readConversationText();
      const urlChanged =
        (target.chatId && window.location.href.includes(target.chatId)) ||
        window.location.href !== prevHref;
      if (nowText && (nowText.slice(0, 200) !== prevText || urlChanged)) {
        break;
      }
    }
    await wait(d(220));

    const conversationText = readConversationText();
    if (!isScriptText(conversationText)) {
      skippedCount++;
      continue;
    }

    // Re-locate row in case Angular re-rendered the list after navigation
    sidebar = await ensureSidebarOpen();
    const refreshedRows = findChatRowsInAllSection(sidebar);
    const rowToAdd =
      (target.chatId
        ? refreshedRows.find((r) => (r.getAttribute('href') || '').includes(target.chatId))
        : null) ||
      (target.href ? refreshedRows.find((r) => r.getAttribute('href') === target.href) : null) ||
      refreshedRows.find((r) => getCleanText(r) === target.title) ||
      rowToOpen;

    const status = await addChatRowToNotebook(rowToAdd);
    if (status === 'added') {
      addedCount++;
      if (target.chatId) alreadyInNotebookIds.add(target.chatId);
    } else if (status === 'already') {
      alreadyCount++;
      if (target.chatId) alreadyInNotebookIds.add(target.chatId);
    } else {
      failedCount++;
    }
  }

  return {
    ok: true,
    notebookName,
    createdNotebook: nbRes.created,
    totalScanned,
    addedCount,
    alreadyCount,
    skippedCount,
    failedCount,
  };
}

export async function runPromptViaWebSession(
  provider: 'chatgpt' | 'gemini',
  prompt: string,
  options?: WebSessionPromptOptions
): Promise<string> {
  if (__AGENTCAST_TARGET__ !== 'main') {
    throw new Error('Webセッション連携モードは個人用（mainブランチ）ビルド専用です。');
  }

  const targetUrl =
    provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';

  options?.onProgress?.('タブを開いています...');
  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  if (!tab.id) {
    throw new Error('バックグラウンドタブの作成に失敗しました。');
  }

  try {
    await waitForTabComplete(tab.id, 22000);
    await sleep(1800);

    options?.onProgress?.('プロンプトを送信中...');
    const submitExec = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runDomSubmitPromptInWebSession,
      args: [provider, prompt],
    });

    const submitPayload = submitExec?.[0]?.result;
    if (!submitPayload?.ok) {
      throw new Error(submitPayload?.error || 'Webセッションへのプロンプト送信に失敗しました。');
    }

    // Poll from the Service Worker (immune to background-tab setTimeout throttling and long-pending executeScript)
    const POLL_INTERVAL_MS = 1500;
    const TOTAL_TIMEOUT_MS = 240_000;
    const NO_RESPONSE_TIMEOUT_MS = 90_000;

    const startTime = Date.now();
    let lastText = '';
    let stablePolls = 0;
    let consecutiveScriptErrors = 0;
    let responseText = '';

    while (Date.now() - startTime < TOTAL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const tabInfo = await chrome.tabs.get(tab.id).catch(() => null);
      if (!tabInfo) {
        throw new Error('Webセッションのタブが閉じられたため生成を中断しました。');
      }

      let pollState: WebSessionPollState | undefined;
      try {
        const pollExec = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: runDomReadWebSessionState,
          args: [provider, submitPayload.initialCount, submitPayload.initialLastText],
        });
        pollState = pollExec?.[0]?.result;
        consecutiveScriptErrors = 0;
      } catch (err) {
        consecutiveScriptErrors++;
        if (consecutiveScriptErrors >= 6) {
          throw new Error(
            `Webセッションの応答読み取りに失敗しました: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        continue;
      }

      if (!pollState) continue;
      if (!pollState.ok) {
        throw new Error(pollState.error || 'Webセッション経由での生成に失敗しました。');
      }

      const txt = pollState.responseText;
      if (!txt) {
        options?.onProgress?.(`応答待機中 (${elapsedSec}秒)`);
        if (Date.now() - startTime >= NO_RESPONSE_TIMEOUT_MS) {
          throw new Error('Webセッションからの応答が開始されませんでした（タイムアウト）。');
        }
        continue;
      }

      if (txt === lastText) {
        stablePolls++;
      } else {
        lastText = txt;
        stablePolls = 0;
      }

      options?.onProgress?.(
        pollState.isGenerating
          ? `応答生成中 ${txt.length.toLocaleString()}文字 (${elapsedSec}秒)`
          : `応答確認中 ${txt.length.toLocaleString()}文字 (${elapsedSec}秒)`
      );

      // Fast completion: valid balanced JSON + generation finished
      if (pollState.hasCompleteJson && !pollState.isGenerating) {
        if ((pollState.hasCompletionUi && stablePolls >= 1) || stablePolls >= 2) {
          responseText = txt;
          break;
        }
      }

      // Guard against false-positive isGenerating selector when complete JSON has stabilized
      if (pollState.hasCompleteJson && stablePolls >= 5) {
        responseText = txt;
        break;
      }

      // Fallback when response is not strict JSON (e.g. minor syntax quirk) but has stabilized after generation stopped
      if (!pollState.isGenerating && txt.includes('{') && txt.includes('}') && stablePolls >= 4) {
        responseText = txt;
        break;
      }
    }

    if (!responseText) {
      // If we timed out with a complete JSON already in hand, still use it rather than discarding
      if (lastText && lastText.includes('{') && lastText.includes('}')) {
        responseText = lastText;
      } else {
        throw new Error('Webセッションからの応答待機がタイムアウトしました。');
      }
    }

    // Best-effort: add newly created Gemini script chat to the designated notebook (e.g. "agentcast")
    // Guarded by a hard 15s timeout so notebook UI changes can never block returning the script.
    if (provider === 'gemini' && options?.notebookName) {
      try {
        options?.onProgress?.(`「${options.notebookName}」ノートブックに整理中...`);
        await sleep(1200);
        const latestTab = await chrome.tabs.get(tab.id).catch(() => null);
        const chatIdHint = extractGeminiChatIdFromUrl(latestTab?.url);
        const nbExec = await Promise.race([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: runDomOrganizeCurrentGeminiChatToNotebook,
            args: [options.notebookName, chatIdHint],
          }),
          sleep(15_000).then(() => null),
        ]);
        const nbPayload = nbExec?.[0]?.result;
        if (!nbPayload?.ok) {
          console.warn(
            '[agentCast] Failed to add script chat to Gemini notebook:',
            nbPayload?.error || 'timed out'
          );
        } else {
          await sleep(500);
        }
      } catch (err) {
        console.warn('[agentCast] Gemini notebook organization warning:', err);
      }
    }

    return responseText;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function organizePastGeminiScriptsToNotebook(
  notebookName = AGENTCAST_NOTEBOOK_NAME
): Promise<GeminiNotebookOrganizeResult> {
  if (__AGENTCAST_TARGET__ !== 'main') {
    throw new Error('Gemini ノートブック整理は個人用（mainブランチ）ビルド専用です。');
  }

  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app', active: false });
  if (!tab.id) {
    throw new Error('バックグラウンドタブの作成に失敗しました。');
  }

  try {
    await waitForTabComplete(tab.id, 25000);
    await sleep(2200);

    const execResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runDomOrganizePastGeminiScriptsToNotebook,
      args: [notebookName, 200],
    });

    const payload = execResults?.[0]?.result;
    if (!payload) {
      throw new Error('Gemini ノートブック整理スクリプトの実行結果を取得できませんでした。');
    }
    if (!payload.ok) {
      throw new Error(payload.error || 'Gemini ノートブックの整理に失敗しました。');
    }
    await sleep(600);
    return payload;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function generateScriptViaWebSession(
  provider: 'chatgpt' | 'gemini',
  items: FeedItem[],
  settings: ExtensionSettings,
  promptOpts?: ScriptPromptOptions,
  onProgress?: (detail: string) => void
): Promise<{ title: string; subtitle: string; chapters: EpisodeChapter[] }> {
  const prompt = buildPodcastScriptPrompt(items, settings, promptOpts);
  const responseText = await runPromptViaWebSession(provider, prompt, {
    ...(provider === 'gemini' ? { notebookName: AGENTCAST_NOTEBOOK_NAME } : {}),
    onProgress,
  });
  return parseGeneratedScriptJson(responseText, items, settings);
}
