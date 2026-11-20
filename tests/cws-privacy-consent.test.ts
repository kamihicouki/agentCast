import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { isPassiveCaptureEnabledInStorage } from '../src/entrypoints/content/index';
import { collectOriginPatterns, toOriginPattern } from '../src/shared/permissions';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('CWS consent gating & permissions', () => {
  it('defaults passiveCaptureEnabled to false on fresh install', () => {
    expect(DEFAULT_SETTINGS.passiveCaptureEnabled).toBe(false);
  });

  it('enables passive capture in content script only when explicitly true in storage', () => {
    expect(isPassiveCaptureEnabledInStorage(undefined)).toBe(false);
    expect(isPassiveCaptureEnabledInStorage(null)).toBe(false);
    expect(isPassiveCaptureEnabledInStorage({})).toBe(false);
    expect(isPassiveCaptureEnabledInStorage({ passiveCaptureEnabled: false })).toBe(false);
    expect(isPassiveCaptureEnabledInStorage({ passiveCaptureEnabled: 'true' })).toBe(false);
    expect(isPassiveCaptureEnabledInStorage({ passiveCaptureEnabled: true })).toBe(true);
  });

  it('normalizes optional_host_permissions origin patterns and ignores non-http URLs', () => {
    expect(toOriginPattern('https://example.com/articles/1?x=1')).toBe('https://example.com/*');
    expect(toOriginPattern('http://localhost:8080/page')).toBe('http://localhost/*');
    expect(toOriginPattern('chrome://extensions')).toBeNull();
    expect(
      collectOriginPatterns([
        'https://zenn.dev/a',
        'https://zenn.dev/b',
        'chrome://settings',
        'https://note.com/x',
      ])
    ).toEqual(['https://zenn.dev/*', 'https://note.com/*']);
  });

  it('requires explicit current consent before sending a production AI request', async () => {
    vi.stubGlobal('__AGENTCAST_TARGET__', 'production');
    vi.resetModules();
    const { DATA_CONSENT_KEY, DATA_CONSENT_VERSION, hasCurrentDataConsent } = await import('../src/shared/data-consent');
    const { generateTextWithOpenAI } = await import('../src/providers/openai-api');
    const get = vi.fn().mockResolvedValue({});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'test result' } }] }),
    });
    vi.stubGlobal('chrome', { storage: { local: { get } } });
    vi.stubGlobal('fetch', fetchMock);

    expect(hasCurrentDataConsent(true)).toBe(false);
    expect(hasCurrentDataConsent(DATA_CONSENT_VERSION + 1)).toBe(false);
    const settings = { ...DEFAULT_SETTINGS, openaiApiKey: 'test-only-fake-key' };
    await expect(generateTextWithOpenAI('test', settings)).rejects.toThrow('同意');
    expect(fetchMock).not.toHaveBeenCalled();

    get.mockResolvedValue({ [DATA_CONSENT_KEY]: DATA_CONSENT_VERSION });
    await expect(generateTextWithOpenAI('test', settings)).resolves.toBe('test result');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('rejects HTTP in production and limits passive capture to the registered HTTPS path', async () => {
    vi.stubGlobal('__AGENTCAST_TARGET__', 'production');
    vi.resetModules();
    const { matchesPassiveSite, toOriginPattern } = await import('../src/shared/permissions');
    const site = {
      id: 'test',
      name: 'Example blog',
      url: 'https://example.com/blog',
      enabled: true,
      passiveEnabled: true,
      scrollSteps: 0,
      extractionStrategy: 'auto' as const,
    };

    expect(toOriginPattern('http://example.com/blog')).toBeNull();
    expect(matchesPassiveSite('https://example.com/blog/latest', [site])).toBe(true);
    expect(matchesPassiveSite('https://example.com/blog-other', [site])).toBe(false);
    expect(matchesPassiveSite('https://example.com:8443/blog', [site])).toBe(false);
    expect(matchesPassiveSite('https://example.com/blog', [{ ...site, passiveEnabled: false }])).toBe(false);
    expect(matchesPassiveSite('https://example.com/blog', [{ ...site, extractionStrategy: 'rss' }])).toBe(false);
  });

  it('replaces legacy plaintext API keys with an encrypted envelope and reads the saved keys back', async () => {
    vi.stubGlobal('__AGENTCAST_TARGET__', 'production');
    vi.resetModules();
    const { default: Dexie } = await import('dexie');
    const { SETTINGS_STORAGE_KEY } = await import('../src/shared/data-consent');
    const { db, getSettings, saveSettings } = await import('../src/storage/db');
    const geminiApiKey = 'locally-generated-test-key';
    let stored: Record<string, unknown> = { geminiApiKey };
    let credentialKey: { id: string; key: CryptoKey } | undefined;
    vi.stubGlobal('chrome', { storage: { local: {
      get: async () => ({ [SETTINGS_STORAGE_KEY]: stored }),
      set: async (data: Record<string, Record<string, unknown>>) => {
        stored = data[SETTINGS_STORAGE_KEY];
      },
    } } });
    vi.stubGlobal('navigator', { locks: {
      request: (_name: string, run: () => Promise<unknown>) => run(),
    } });
    vi.spyOn(db.credentialKeys, 'get').mockImplementation(() => Dexie.Promise.resolve(credentialKey));
    vi.spyOn(db.credentialKeys, 'add').mockImplementation((record) => {
      credentialKey = record;
      return Dexie.Promise.resolve(record.id);
    });
    vi.spyOn(db, 'transaction').mockImplementation((...args: unknown[]) => {
      return Dexie.Promise.resolve((args.at(-1) as () => Promise<unknown>)());
    });

    expect((await getSettings()).geminiApiKey).toBe(geminiApiKey);
    await saveSettings({ playbackRate: 1.25 });
    expect(stored).not.toHaveProperty('geminiApiKey');
    expect(stored).toHaveProperty('encryptedApiKeys');
    expect(credentialKey?.key.extractable).toBe(false);
    await expect(getSettings()).resolves.toMatchObject({ geminiApiKey, playbackRate: 1.25 });
    await saveSettings({ geminiApiKey: '' });
    expect(stored).not.toHaveProperty('encryptedApiKeys');
  });
});
