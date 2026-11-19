import type { BuildMeta } from '../../shared/types';
import type { DevBuildStatus } from '../../shared/messages';

const RUNNING_BUILD_ID =
  typeof __AGENTCAST_BUILD_ID__ !== 'undefined' ? __AGENTCAST_BUILD_ID__ : '';
const RUNNING_VERSION =
  typeof __AGENTCAST_VERSION__ !== 'undefined' ? __AGENTCAST_VERSION__ : '0.0.0';

let currentBuild: BuildMeta | null = RUNNING_BUILD_ID
  ? {
      buildId: RUNNING_BUILD_ID,
      contentHash: '',
      builtAt: '',
      target: 'main',
      version: RUNNING_VERSION,
    }
  : null;
let pendingBuild: BuildMeta | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchDiskBuildMeta(): Promise<BuildMeta | null> {
  try {
    const url = `${chrome.runtime.getURL('build-meta.json')}?t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BuildMeta;
  } catch {
    return null;
  }
}

export function getDevBuildStatus(): DevBuildStatus {
  return {
    currentBuild,
    pendingBuild,
  };
}

/**
 * Watches build-meta.json on local disk (updated via Google Drive sync, git pull, or pnpm dev).
 * Compares against compile-time __AGENTCAST_BUILD_ID__ so even if the Service Worker slept during
 * a Drive sync, waking up immediately detects the newer disk build and triggers chrome.runtime.reload().
 */
export function startDevAutoReloader(isBusyFn: () => boolean): void {
  if (!__DEV_AUTO_RELOAD__) return;
  if (pollTimer) return;

  const checkForUpdate = async () => {
    const latest = await fetchDiskBuildMeta();
    if (!latest) return;

    if (!RUNNING_BUILD_ID) {
      if (!currentBuild) {
        currentBuild = latest;
        return;
      }
    } else if (latest.buildId === RUNNING_BUILD_ID) {
      currentBuild = latest;
      return;
    }

    const activeId = RUNNING_BUILD_ID || currentBuild?.buildId;
    if (activeId && latest.buildId !== activeId) {
      pendingBuild = latest;
      if (!isBusyFn()) {
        console.log(
          `[agentCast dev-reloader] New build detected (${activeId} -> ${latest.buildId}). Reloading extension...`
        );
        chrome.runtime.reload();
      } else {
        chrome.runtime
          .sendMessage({
            type: 'DEV_BUILD_UPDATE_AVAILABLE',
            pendingBuild: latest,
          })
          .catch(() => {});
      }
    }
  };

  // Check immediately on SW wakeup, then every 3.5 seconds while awake
  void checkForUpdate();
  pollTimer = setInterval(() => {
    void checkForUpdate();
  }, 3500);
}
