/**
 * One-click semi-automated OpenAI API key onboarding helper for OpenAI TTS / API users.
 * Opens https://platform.openai.com/api-keys, guides the user to create a new secret key
 * (never bypassing sign-in, 2FA, or Terms of Service consent), automatically detects newly
 * generated unmasked sk-... keys in the modal or on copy, verifies and saves them into agentCast.
 */

import { requireDataConsent } from '../../shared/data-consent';

const OPENAI_KEY_CANDIDATE_REGEX = /\b(sk-(?:proj-|svcacct-|admin-|live-)?[A-Za-z0-9_-]{20,})\b/g;

/**
 * Extracts a full, unmasked OpenAI secret key from text.
 * Rejects masked placeholders such as `sk-proj-...1234`, `sk-••••1234`, or `sk-****1234`.
 */
export function extractOpenAiApiKey(raw: string): string | null {
  if (!raw) return null;
  OPENAI_KEY_CANDIDATE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPENAI_KEY_CANDIDATE_REGEX.exec(raw)) !== null) {
    const candidate = match[1];
    const start = match.index;
    const end = start + candidate.length;
    const surrounding = raw.slice(Math.max(0, start - 3), Math.min(raw.length, end + 6));
    if (
      surrounding.includes('...') ||
      surrounding.includes('…') ||
      surrounding.includes('•') ||
      surrounding.includes('*')
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

export async function verifyOpenAiApiKey(
  apiKey: string
): Promise<{ valid: boolean; message: string }> {
  const trimmed = apiKey.trim();
  if (!extractOpenAiApiKey(trimmed) || extractOpenAiApiKey(trimmed) !== trimmed) {
    return {
      valid: false,
      message: 'APIキーの形式が正しくありません（sk-... で始まる OpenAI API キーを確認してください）。',
    };
  }

  try {
    await requireDataConsent();
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
      redirect: 'error',
    });

    if (res.ok) {
      return {
        valid: true,
        message: '接続テスト成功！OpenAI 台本生成 & OpenAI TTS（話者別MP3合成）が利用可能です。',
      };
    }

    const errText = await res.text();
    if (res.status === 401) {
      return {
        valid: false,
        message: 'APIキーが無効です（HTTP 401）。キーが正しくコピーされているか確認してください。',
      };
    }
    if (res.status === 429 && /insufficient_quota|billing/i.test(errText)) {
      return {
        valid: false,
        message:
          'APIキーは認識されましたが、OpenAI API のクレジット残高が不足しています（Billing でチャージしてください）。',
      };
    }
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
 * Self-contained DOM script injected into https://platform.openai.com/api-keys.
 * Must not reference outer closure variables so chrome.scripting.executeScript serializes it cleanly.
 */
export function injectOpenAiKeyHelper(): void {
  const win = window as Window & { __agentCastOpenAiKeyHelperActive__?: boolean };
  if (win.__agentCastOpenAiKeyHelperActive__) return;
  win.__agentCastOpenAiKeyHelperActive__ = true;

  const KEY_RE = /\b(sk-(?:proj-|svcacct-|admin-|live-)?[A-Za-z0-9_-]{20,})\b/g;
  let detectedKey = '';
  let alreadySent = false;
  let sending = false;

  const findFullOpenAiKey = (raw: string): string | null => {
    if (!raw || !raw.includes('sk-')) return null;
    KEY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KEY_RE.exec(raw)) !== null) {
      const candidate = m[1];
      const start = m.index;
      const end = start + candidate.length;
      const surrounding = raw.slice(Math.max(0, start - 3), Math.min(raw.length, end + 6));
      if (
        surrounding.includes('...') ||
        surrounding.includes('…') ||
        surrounding.includes('•') ||
        surrounding.includes('*')
      ) {
        continue;
      }
      return candidate;
    }
    return null;
  };

  // Create sleek floating studio assistant banner at bottom-right of OpenAI Platform
  const host = document.createElement('div');
  host.id = 'agentcast-openai-apikey-assistant';
  host.style.cssText = [
    'position:fixed',
    'right:20px',
    'bottom:20px',
    'z-index:2147483647',
    'width:356px',
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
  titleEl.style.cssText =
    'font-weight:700;font-size:14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;';
  titleEl.innerHTML = '<span>🎙 agentCast OpenAI ワンクリック連携</span>';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText =
    'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
  closeBtn.onclick = () => host.remove();
  titleEl.appendChild(closeBtn);

  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'color:#c4bdb1;font-size:12.5px;margin-bottom:10px;';
  statusEl.textContent =
    '「Create new secret key」でキーを作成すると、agentCast が自動検出して接続テスト〜設定まで完了します。';

  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const highlightCreateBtn = document.createElement('button');
  highlightCreateBtn.textContent = 'キー作成ダイアログを開く';
  highlightCreateBtn.style.cssText =
    'flex:1;background:#2a2e36;color:#f4efe6;border:1px solid rgba(244,239,230,0.18);border-radius:8px;padding:7px 10px;font-weight:600;font-size:12px;cursor:pointer;';

  const applyKeyBtn = document.createElement('button');
  applyKeyBtn.textContent = 'このキーを agentCast に設定';
  applyKeyBtn.style.cssText =
    'display:none;flex:1;background:#e56b43;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:700;font-size:12.5px;cursor:pointer;';

  const billingLink = document.createElement('a');
  billingLink.href = 'https://platform.openai.com/settings/organization/billing/overview';
  billingLink.target = '_blank';
  billingLink.rel = 'noreferrer';
  billingLink.textContent = 'クレジット残高(Billing)を確認 ↗';
  billingLink.style.cssText =
    'display:inline-block;margin-top:8px;color:#9b958b;font-size:11.5px;text-decoration:underline;';

  actionRow.appendChild(highlightCreateBtn);
  actionRow.appendChild(applyKeyBtn);
  host.appendChild(titleEl);
  host.appendChild(statusEl);
  host.appendChild(actionRow);
  host.appendChild(billingLink);
  document.body.appendChild(host);

  const sendKeyToExtension = (key: string) => {
    if (alreadySent || sending || !findFullOpenAiKey(key)) return;
    sending = true;
    const masked = `${key.slice(0, 10)}••••••••${key.slice(-4)}`;
    statusEl.style.color = '#f4efe6';
    statusEl.textContent = `OpenAI APIキー (${masked}) を検出！接続テストして連携中...`;
    applyKeyBtn.disabled = true;

    chrome.runtime.sendMessage(
      {
        type: 'OPENAI_KEY_CAPTURED',
        apiKey: key,
        closeSetupTab: false,
      },
      (res) => {
        sending = false;
        if (res?.ok) {
          alreadySent = true;
          statusEl.style.color = '#65c493';
          statusEl.textContent =
            '✅ OpenAI TTS 連携完了！Side Panel に戻ってそのまま番組を作成できます（このタブは閉じてOKです）。';
          applyKeyBtn.style.display = 'none';
          highlightCreateBtn.style.display = 'none';
        } else {
          applyKeyBtn.disabled = false;
          applyKeyBtn.style.display = 'inline-block';
          statusEl.style.color = '#ef857d';
          statusEl.textContent = res?.error || '連携に失敗しました。もう一度お試しください。';
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
          txt.includes('create new secret key') ||
          txt.includes('新しいシークレットキー') ||
          txt.includes('create secret key')
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
      statusEl.style.color = '#f4efe6';
      statusEl.textContent =
        '作成ダイアログを開きました。名前（例: agentCast）を入れて「Create secret key」を押すと自動で連携します。';
    } else {
      statusEl.textContent =
        'ログイン後、ページ内の「+ Create new secret key」ボタンをクリックしてください。';
    }
  };

  const handleDetectedKey = (key: string) => {
    if (alreadySent || sending) return;
    if (detectedKey === key) return;
    detectedKey = key;
    highlightCreateBtn.style.display = 'none';
    applyKeyBtn.style.display = 'inline-block';
    sendKeyToExtension(key);
  };

  const scanForKey = () => {
    if (alreadySent || sending) return;

    const candidates: string[] = [];
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea'
    )) {
      if (input.value && input.value.includes('sk-')) candidates.push(input.value);
    }
    for (const el of document.querySelectorAll('code, pre, [role="dialog"], span')) {
      const txt = el.textContent || '';
      if (txt.includes('sk-') && txt.length < 400) {
        candidates.push(txt);
      }
    }

    for (const raw of candidates) {
      const key = findFullOpenAiKey(raw);
      if (key) {
        handleDetectedKey(key);
        return;
      }
    }
  };

  // Capture when the user clicks OpenAI's "Copy" button in the Save your key modal
  document.addEventListener('copy', () => {
    const selection = window.getSelection()?.toString() || '';
    const key = findFullOpenAiKey(selection);
    if (key) {
      handleDetectedKey(key);
    }
  });

  const observer = new MutationObserver(() => scanForKey());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.setInterval(scanForKey, 1000);
  scanForKey();
}
