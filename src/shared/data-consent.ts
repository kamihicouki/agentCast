export const SETTINGS_STORAGE_KEY = 'agentcast_settings_v1';
export const DATA_CONSENT_KEY = 'agentcast_data_consent_version';
export const DATA_CONSENT_VERSION = 1;
export const DATA_CONSENT_REQUIRED = typeof __AGENTCAST_TARGET__ !== 'undefined' &&
  __AGENTCAST_TARGET__ === 'production';
export const PRIVACY_POLICY_URL =
  'https://github.com/kamihicouki/agentCast/blob/main/docs/chrome-web-store/PRIVACY_POLICY.md';

export function hasCurrentDataConsent(value: unknown): boolean {
  return !DATA_CONSENT_REQUIRED || value === DATA_CONSENT_VERSION;
}

export async function hasDataConsent(): Promise<boolean> {
  if (!DATA_CONSENT_REQUIRED) return true;
  const saved = await chrome.storage.local.get(DATA_CONSENT_KEY);
  return hasCurrentDataConsent(saved[DATA_CONSENT_KEY]);
}

export async function requireDataConsent(): Promise<void> {
  if (!(await hasDataConsent())) {
    throw new Error('agentCast のデータ取り扱いに同意してから操作してください。');
  }
}
