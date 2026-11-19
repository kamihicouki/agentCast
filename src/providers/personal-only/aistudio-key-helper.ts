/**
 * Semi-automated Gemini API key onboarding helper for Google AI Pro / Ultra users.
 * Opens https://aistudio.google.com/apikey, guides the user to click "Create API key" (never bypassing
 * sign-in or Terms of Service consent), detects newly generated or revealed AIzaSy... keys on screen
 * or via copy button, and lets the user send it into agentCast with 1 click.
 */

const GEMINI_KEY_REGEX = /\b(AIza[0-9A-Za-z_-]{35})\b/;

export async function verifyGeminiApiKey(
  apiKey: string
): Promise<{ valid: boolean; message: string }> {
  const trimmed = apiKey.trim();
  if (!GEMINI_KEY_REGEX.test(trimmed)) {
    return {
      valid: false,
      message: 'APIキーの形式が正しくありません（AIza... で始まる39文字のキーを確認してください）。',
    };
  }

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=5',
      {
        headers: { 'x-goog-api-key': trimmed },
      }
    );

    if (res.ok) {
      return {
        valid: true,
        message: '接続テスト成功！Gemini 台本生成 & 2話者マルチスピーカー音声が利用可能です。',
      };
    }

    const errText = await res.text();
    return {
      valid: false,
      message: `APIキー認証エラー (HTTP ${res.status}): ${errText.slice(0, 140)}`,
    };
  } catch (err) {
    return {
      valid: false,
      message: `ネットワークエラー: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Self-contained DOM script injected into https://aistudio.google.com/apikey.
 * Must not reference outer closure variables so chrome.scripting.executeScript serializes it cleanly.
 */
export function injectAiStudioKeyHelper(): void {
  const win = window as Window & { __agentCastKeyHelperActive__?: boolean };
  if (win.__agentCastKeyHelperActive__) return;
  win.__agentCastKeyHelperActive__ = true;

  const KEY_RE = /\b(AIza[0-9A-Za-z_-]{35})\b/;
  let detectedKey = '';
  let alreadySent = false;

  // Create sleek floating studio assistant banner at bottom-right of AI Studio
  const host = document.createElement('div');
  host.id = 'agentcast-apikey-assistant';
  host.style.cssText = [
    'position:fixed',
    'right:20px',
    'bottom:20px',
    'z-index:2147483647',
    'width:340px',
    'background:#181a1f',
    'color:#f4efe6',
    'border:1px solid rgba(229,107,67,0.55)',
    'border-radius:14px',
    'padding:14px 16px',
    'box-shadow:0 14px 36px rgba(0,0,0,0.45)',
    'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif',
    'font-size:13px',
    'line-height:1.5',
  ].join(';');

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;';
  titleEl.innerHTML = '<span>🎙 agentCast かんたんキー設定</span>';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
  closeBtn.onclick = () => host.remove();
  titleEl.appendChild(closeBtn);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'color:#c4bdb1;font-size:12.5px;margin-bottom:10px;';
  statusEl.textContent =
    '「API キーを作成（Create API key）」を押すか、既存のキーを開くと agentCast が自動検出します。';

  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const highlightCreateBtn = document.createElement('button');
  highlightCreateBtn.textContent = '作成ボタンを開く';
  highlightCreateBtn.style.cssText =
    'flex:1;background:#2a2e36;color:#f4efe6;border:1px solid rgba(244,239,230,0.18);border-radius:8px;padding:7px 10px;font-weight:600;font-size:12px;cursor:pointer;';

  const applyKeyBtn = document.createElement('button');
  applyKeyBtn.textContent = 'このキーを agentCast に設定';
  applyKeyBtn.style.cssText =
    'display:none;flex:1;background:#e56b43;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:700;font-size:12.5px;cursor:pointer;';

  actionRow.appendChild(highlightCreateBtn);
  actionRow.appendChild(applyKeyBtn);
  host.appendChild(titleEl);
  host.appendChild(statusEl);
  host.appendChild(actionRow);
  document.body.appendChild(host);

  const sendKeyToExtension = (key: string) => {
    if (alreadySent || !KEY_RE.test(key)) return;
    alreadySent = true;
    statusEl.textContent = 'agentCast へキーを保存して接続テスト中...';
    applyKeyBtn.disabled = true;

    chrome.runtime.sendMessage(
      {
        type: 'GEMINI_KEY_CAPTURED',
        apiKey: key,
        closeSetupTab: false,
      },
      (res) => {
        if (res?.ok) {
          statusEl.style.color = '#65c493';
          statusEl.textContent =
            '✅ 設定完了！Side Panel に戻ってそのまま番組を作成できます（このタブは閉じてOKです）。';
          applyKeyBtn.style.display = 'none';
          highlightCreateBtn.style.display = 'none';
        } else {
          alreadySent = false;
          applyKeyBtn.disabled = false;
          statusEl.style.color = '#ef857d';
          statusEl.textContent = res?.error || '設定に失敗しました。もう一度お試しください。';
        }
      }
    );
  };

  applyKeyBtn.onclick = () => {
    if (detectedKey) sendKeyToExtension(detectedKey);
  };

  const findCreateKeyButton = (): HTMLButtonElement | null => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    return (
      buttons.find((b) => {
        const txt = (b.textContent || '').trim().toLowerCase();
        return (
          txt.includes('create api key') ||
          txt.includes('api キーを作成') ||
          txt.includes('apiキーを作成')
        );
      }) || null
    );
  };

  highlightCreateBtn.onclick = () => {
    const btn = findCreateKeyButton();
    if (btn) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      btn.style.outline = '3px solid #e56b43';
      btn.style.outlineOffset = '3px';
      btn.click();
      statusEl.textContent =
        '作成ダイアログを開きました。プロジェクトを選んでキーが生成されると自動で検出します。';
    } else {
      statusEl.textContent =
        'ページ内の「Create API key / API キーを作成」ボタンをクリックしてください。';
    }
  };

  const scanForKey = () => {
    if (alreadySent) return;

    // 1. Check input fields, code blocks, dialogs, and visible text nodes for full AIzaSy... key
    const candidates: string[] = [];
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea'
    )) {
      if (input.value && input.value.includes('AIza')) candidates.push(input.value);
    }
    for (const el of document.querySelectorAll('code, pre, [role="dialog"], .apikey-text, span')) {
      const txt = el.textContent || '';
      if (txt.includes('AIza') && txt.length < 300) {
        candidates.push(txt);
      }
    }

    for (const raw of candidates) {
      const match = KEY_RE.exec(raw);
      if (match?.[1]) {
        detectedKey = match[1];
        const masked = `${detectedKey.slice(0, 8)}••••••••${detectedKey.slice(-4)}`;
        statusEl.style.color = '#f4efe6';
        statusEl.textContent = `Gemini APIキー (${masked}) を検出しました！下のボタンで即設定できます。`;
        highlightCreateBtn.style.display = 'none';
        applyKeyBtn.style.display = 'inline-block';
        return;
      }
    }
  };

  // Also capture if the user clicks Google AI Studio's own "Copy" button!
  document.addEventListener('copy', () => {
    const selection = window.getSelection()?.toString() || '';
    const match = KEY_RE.exec(selection);
    if (match?.[1]) {
      detectedKey = match[1];
      const masked = `${detectedKey.slice(0, 8)}••••••••${detectedKey.slice(-4)}`;
      statusEl.textContent = `コピーされたキー (${masked}) を検出しました！ボタンを押すと設定完了します。`;
      highlightCreateBtn.style.display = 'none';
      applyKeyBtn.style.display = 'inline-block';
    }
  });

  const observer = new MutationObserver(() => scanForKey());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.setInterval(scanForKey, 1000);
  scanForKey();
}
