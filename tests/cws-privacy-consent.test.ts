import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { isPassiveCaptureEnabledInStorage } from '../src/entrypoints/content/index';
import { collectOriginPatterns, toOriginPattern } from '../src/shared/permissions';

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
});
