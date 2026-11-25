import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('OpenAI & Gemini one-click key setup helpers', () => {
  it('extracts full OpenAI secret keys and rejects masked or invalid values', async () => {
    const { extractOpenAiApiKey } = await import(
      '../src/providers/personal-only/openai-key-helper'
    );

    const projKey = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const legacyKey = 'sk-1234567890abcdefghij1234567890';
    expect(extractOpenAiApiKey(projKey)).toBe(projKey);
    expect(extractOpenAiApiKey(`Your new key is ${projKey} please save it`)).toBe(projKey);
    expect(extractOpenAiApiKey(legacyKey)).toBe(legacyKey);

    expect(extractOpenAiApiKey('')).toBeNull();
    expect(extractOpenAiApiKey('sk-short')).toBeNull();
    expect(extractOpenAiApiKey('sk-proj-AbCdEfGhIjKlMnOpQrStUv...1234')).toBeNull();
    expect(extractOpenAiApiKey('sk-proj-AbCdEfGhIjKlMnOpQrStUv••••1234')).toBeNull();
    expect(extractOpenAiApiKey('sk-proj-AbCdEfGhIjKlMnOpQrStUv****1234')).toBeNull();
    expect(extractOpenAiApiKey('AIzaSyA12345678901234567890123456789012')).toBeNull();
  });

  it('validates OpenAI API keys locally and handles 200 / 401 / 429 responses', async () => {
    const { verifyOpenAiApiKey } = await import(
      '../src/providers/personal-only/openai-key-helper'
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const emptyRes = await verifyOpenAiApiKey('');
    expect(emptyRes.valid).toBe(false);
    expect(emptyRes.message).toContain('sk-');
    expect(fetchMock).not.toHaveBeenCalled();

    const validKey = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const okRes = await verifyOpenAiApiKey(validKey);
    expect(okRes.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${validKey}` },
        redirect: 'error',
      })
    );

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const badRes = await verifyOpenAiApiKey(validKey);
    expect(badRes.valid).toBe(false);
    expect(badRes.message).toContain('401');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '{"error":{"code":"insufficient_quota"}}',
    });
    const quotaRes = await verifyOpenAiApiKey(validKey);
    expect(quotaRes.valid).toBe(false);
    expect(quotaRes.message).toContain('クレジット残高');
  });

  it('auto-captures full OpenAI key in DOM while ignoring masked keys', async () => {
    const { injectOpenAiKeyHelper } = await import(
      '../src/providers/personal-only/openai-key-helper'
    );

    const dom = new JSDOM(
      `<!doctype html><html><body>
        <table><tr><td><span>sk-proj-AbCdEfGhIjKlMnOpQrStUv...1234</span></td></tr></table>
      </body></html>`,
      { url: 'https://platform.openai.com/api-keys' }
    );
    const sendMessage = vi.fn((_msg, cb) => cb?.({ ok: true }));
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    injectOpenAiKeyHelper();
    expect(dom.window.document.getElementById('agentcast-openai-apikey-assistant')).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    const fullKey = 'sk-proj-ZzYyXxWwVvUuTtSsRrQqPpOoNnMm12345678';
    const dialog = dom.window.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const input = dom.window.document.createElement('input');
    input.value = fullKey;
    dialog.appendChild(input);
    dom.window.document.body.appendChild(dialog);

    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OPENAI_KEY_CAPTURED', apiKey: fullKey }),
      expect.any(Function)
    );
    expect(
      dom.window.document.getElementById('agentcast-openai-apikey-assistant')?.textContent
    ).toContain('連携完了');

    dom.window.close();
  });

  it('auto-captures full Gemini key in AI Studio DOM', async () => {
    const { injectAiStudioKeyHelper } = await import(
      '../src/providers/personal-only/aistudio-key-helper'
    );

    const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
      url: 'https://aistudio.google.com/apikey',
    });
    const sendMessage = vi.fn((_msg, cb) => cb?.({ ok: true }));
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    injectAiStudioKeyHelper();
    expect(dom.window.document.getElementById('agentcast-apikey-assistant')).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    const fullKey = 'AIzaSyA12345678901234567890123456789012';
    const code = dom.window.document.createElement('code');
    code.textContent = fullKey;
    dom.window.document.body.appendChild(code);

    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GEMINI_KEY_CAPTURED', apiKey: fullKey }),
      expect.any(Function)
    );
    expect(
      dom.window.document.getElementById('agentcast-apikey-assistant')?.textContent
    ).toContain('連携完了');

    dom.window.close();
  });

  it('validates and auto-captures new AQ. format Gemini API keys', async () => {
    const { verifyGeminiApiKey, injectAiStudioKeyHelper } = await import(
      '../src/providers/personal-only/aistudio-key-helper'
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const aqKey = `AQ.Ab8RN6${'TestKey1234'.repeat(4)}`;
    const okRes = await verifyGeminiApiKey(aqKey);
    expect(okRes.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=5',
      expect.objectContaining({
        headers: { 'x-goog-api-key': aqKey },
        redirect: 'error',
      })
    );

    const shortAqRes = await verifyGeminiApiKey('AQ.Ab8RN6short');
    expect(shortAqRes.valid).toBe(false);
    expect(shortAqRes.message).toContain('AQ.');

    const dom = new JSDOM(
      `<!doctype html><html><body><span>AQ.Ab8RN6...</span></body></html>`,
      { url: 'https://aistudio.google.com/apikey' }
    );
    const sendMessage = vi.fn((_msg, cb) => cb?.({ ok: true }));
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    injectAiStudioKeyHelper();
    expect(sendMessage).not.toHaveBeenCalled();

    const span = dom.window.document.createElement('span');
    span.textContent = aqKey;
    dom.window.document.body.appendChild(span);

    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GEMINI_KEY_CAPTURED', apiKey: aqKey }),
      expect.any(Function)
    );

    dom.window.close();
  });

  it('forwards configured openaiTtsModel in synthesizeChapterWithOpenAITts', async () => {
    const { synthesizeChapterWithOpenAITts } = await import('../src/providers/openai-api');
    const { DEFAULT_SETTINGS } = await import('../src/shared/types');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x00]).buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const chapter = {
      id: 'ch-1',
      index: 0,
      title: 'Test Chapter',
      summary: 'Summary',
      durationSec: 10,
      hasAudioBlob: false,
      sourceItems: [],
      turns: [
        { id: 't-1', speaker: 'HostA' as const, speakerName: 'カイ', text: 'こんにちは' },
        { id: 't-2', speaker: 'HostB' as const, speakerName: 'ミオ', text: 'よろしくお願いします' },
      ],
    };

    const settings = {
      ...DEFAULT_SETTINGS,
      openaiApiKey: 'sk-proj-TestKeyForUnitTest1234567890',
      openaiTtsModel: 'gpt-4o-mini-tts',
    };

    const res = await synthesizeChapterWithOpenAITts(chapter, settings);
    expect(res.mimeType).toBe('audio/mpeg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstBody.model).toBe('gpt-4o-mini-tts');
    expect(firstBody.voice).toBe('onyx');
    expect(secondBody.model).toBe('gpt-4o-mini-tts');
    expect(secondBody.voice).toBe('nova');
  });
});
