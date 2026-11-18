import type { BuildMeta } from '../../shared/types';
import type { DevBuildStatus } from '../../shared/messages';

let initialBuild: BuildMeta | null = null;
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
    currentBuild: initialBuild,
    pendingBuild,
  };
}

/**
 * Watches build-meta.json on local disk (updated via Google Drive sync, git pull, or pnpm dev).
 * Automatically calls chrome.runtime.reload() when idle so cloud updates appear in local Chrome immediately,
 * while holding reload safely if podcast audio is currently playing.
 */
export function startDevAutoReloader(isAudioPlayingFn: () => boolean): void {
  if (!__DEV_AUTO_RELOAD__) return;
  if (pollTimer) return;

  void fetchDiskBuildMeta().then((meta) => {
    initialBuild = meta;
  });

  pollTimer = setInterval(async () => {
    const latest = await fetchDiskBuildMeta();
    if (!latest) return;

    if (!initialBuild) {
      initialBuild = latest;
      return;
    }

    if (latest.buildId !== initialBuild.buildId) {
      pendingBuild = latest;
      if (!isAudioPlayingFn()) {
        console.log(
          `[agentCast dev-reloader] New build detected (${latest.buildId}). Reloading extension...`
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
  }, 3500);
}
