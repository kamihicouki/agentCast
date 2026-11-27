import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  db,
  getSettings,
  getUnreadQueue,
} from '../../storage/db';
import {
  APP_THEMES,
  DEFAULT_SETTINGS,
  INITIAL_PLAYBACK_STATE,
  PATROL_SOURCE_IDS,
  type AppThemeId,
  type BuildMeta,
  type ExtensionSettings,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type TabGroupSummary,
} from '../../shared/types';
import type { DevBuildStatus, PublishPipelineStatus, RuntimeRequest } from '../../shared/messages';
import {
  DATA_CONSENT_KEY,
  DATA_CONSENT_REQUIRED,
  DATA_CONSENT_VERSION,
  hasCurrentDataConsent,
  hasDataConsent,
  PRIVACY_POLICY_URL,
} from '../../shared/data-consent';
import {
  ensureHostPermissionsForUrls,
  patrolPermissionUrls,
  requestPatrolPermissions,
} from '../../shared/permissions';
import {
  copyEpisodeMarkdown,
  downloadEpisodeAudio,
  downloadPortableHtmlPlayer,
  shareEpisodeNative,
} from '../../shared/export-utils';
import {
  buildYouTubeStudioUploadUrl,
  renderEpisodeToMp4,
} from '../../shared/publish-utils';
import { SettingsPanel } from './SettingsPanel';
import { PatrolPanel } from './PatrolPanel';
import { QueuePanel } from './QueuePanel';
import { PlayerPanel, type ResynthesizeRequest } from './PlayerPanel';
import { formatRemainingTime } from '../../shared/progress-utils';

type ActiveTab = 'listen' | 'sources' | 'settings';
type SourcesSubTab = 'patrol' | 'queue';

const SPEED_STEPS = [1.0, 1.25, 1.5, 1.75, 2.0];

function formatSec(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatEpisodeTimestamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function deriveEpisodeSubtitle(ep: PodcastEpisode): string {
  const raw = (ep.subtitle || '').trim();
  const isGeneric =
    !raw ||
    raw.length < 10 ||
    /件の新着(記事|SNS|トピック)|トレンド＆テックダイジェスト|整理しています/.test(raw);
  if (!isGeneric) return raw;

  const topicTitles = (ep.chapters || [])
    .map((c) => c.title.trim())
    .filter(
      (t) =>
        t &&
        !/^(オープニング|導入|エンディング|まとめ)[:：]?$/i.test(t) &&
        !t.startsWith('オープニング：')
    );

  if (topicTitles.length > 0) {
    return topicTitles.slice(0, 3).join(' ／ ');
  }
  return raw || `${ep.sourceCount}件のソースから編成`;
}

export function App() {
  const [accepted, setAccepted] = useState<boolean | null>(DATA_CONSENT_REQUIRED ? null : true);
  const [saving, setSaving] = useState(false);
  const [consentError, setConsentError] = useState('');

  useEffect(() => {
    if (!DATA_CONSENT_REQUIRED) return;
    let active = true;
    let observedChange = false;
    const onChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area !== 'local' || !changes[DATA_CONSENT_KEY]) return;
      observedChange = true;
      setAccepted(hasCurrentDataConsent(changes[DATA_CONSENT_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    void hasDataConsent().then((value) => {
      if (active && !observedChange) setAccepted(value);
    }).catch(() => {
      if (active && !observedChange) setAccepted(false);
    });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  if (accepted) {
    return <AgentCastStudio onRevokeConsent={DATA_CONSENT_REQUIRED ? async () => {
      await chrome.storage.local.remove(DATA_CONSENT_KEY);
    } : undefined} />;
  }

  const accept = async () => {
    setSaving(true);
    setConsentError('');
    try {
      await chrome.storage.local.set({ [DATA_CONSENT_KEY]: DATA_CONSENT_VERSION });
      setAccepted(true);
    } catch {
      setConsentError('同意を保存できませんでした。もう一度お試しください。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="studio-main">
      <section className="n-primary-card" aria-labelledby="agentcast-data-consent">
        <h1 id="agentcast-data-consent">agentCast のデータ取り扱い</h1>
        {accepted === null ? <p role="status">設定を読み込み中です。</p> : <>
          <ul>
            <li>指定したサイトやタブの URL・見出し・本文、購読ソース、設定、API キー、生成物は Chrome 内に保存します。閲覧中の受動収集と定時巡回は個別にオンにできます。</li>
            <li>番組作成時は素材のテキスト・URL・番組設定・直近番組の見出しと要約を、設定した Gemini API または OpenAI API に送信します。定時生成では未読素材も自動で選びます。</li>
            <li>YouTube 要約では動画情報・字幕または動画 URL、クラウド音声合成では生成した台本を AI に送信します。API キーは対応するサービスへの認証に使います。</li>
            <li>Gemini には Cloud Billing が有効なプロジェクトのキーを使い、OpenAI API ではモデル改善へのデータ共有をオフにしてください。</li>
            <li>共有・公開補助を使うと、番組の投稿文や動画が選択した共有先、YouTube または X に渡ります。開発者への送信やトラッキングはありません。</li>
          </ul>
          <p>同意は設定で取り消せます。同意せずにサイドパネルを閉じることもできます。</p>
          <p><a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">プライバシーポリシー</a></p>
          <button className="btn-primary" type="button" disabled={saving} onClick={() => void accept()}>
            データの取り扱いに同意して続ける
          </button>
          {consentError && <p role="alert">{consentError}</p>}
        </>}
      </section>
    </main>
  );
}

function AgentCastStudio({ onRevokeConsent }: { onRevokeConsent?: () => Promise<void> }) {
  const [tab, setTab] = useState<ActiveTab>('listen');
  const [sourcesSubTab, setSourcesSubTab] = useState<SourcesSubTab>('patrol');
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [queue, setQueue] = useState<FeedItem[]>([]);
  const [tabGroups, setTabGroups] = useState<TabGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | ''>('');
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK_STATE);
  const [isJobRunning, setIsJobRunning] = useState<boolean>(false);
  const [isResynthRunning, setIsResynthRunning] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [jobProgressPercent, setJobProgressPercent] = useState<number | null>(null);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const [jobEstimatedRemainingSec, setJobEstimatedRemainingSec] = useState<number | null>(null);
  const [resynthMessage, setResynthMessage] = useState<string>('');
  const [exportMessage, setExportMessage] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [currentBuild, setCurrentBuild] = useState<BuildMeta | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildMeta | null>(null);
  const [isVerifyingKey, setIsVerifyingKey] = useState<boolean>(false);
  const [keyVerifyStatus, setKeyVerifyStatus] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [isVerifyingOpenAiKey, setIsVerifyingOpenAiKey] = useState<boolean>(false);
  const [openAiKeyVerifyStatus, setOpenAiKeyVerifyStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [isOrganizingGeminiNotebook, setIsOrganizingGeminiNotebook] = useState<boolean>(false);
  const [geminiNotebookStatus, setGeminiNotebookStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [publishStatus, setPublishStatus] = useState<PublishPipelineStatus | null>(null);

  const activeTurnRef = useRef<HTMLDivElement | null>(null);

  // Apply active theme to root document and cache in localStorage
  useEffect(() => {
    const activeTheme: AppThemeId = settings.theme || 'braun';
    document.documentElement.dataset.theme = activeTheme;
    try {
      localStorage.setItem('agentcast_theme', activeTheme);
    } catch {
      // ignore storage errors
    }
  }, [settings.theme]);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? '' : prev));
    }, 3400);
  }, []);

  const refreshTabGroups = useCallback(async () => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_TAB_GROUPS',
      } satisfies RuntimeRequest)) as { ok?: boolean; groups?: TabGroupSummary[] };
      if (res?.ok && Array.isArray(res.groups)) {
        setTabGroups(res.groups);
        setSelectedGroupId((prev) => {
          if (prev !== '' && res.groups!.some((g) => g.id === prev)) return prev;
          return res.groups![0]?.id ?? '';
        });
      }
    } catch {
      // ignore if tabGroups unavailable
    }
  }, []);

  const refreshData = useCallback(async () => {
    const [eps, unread, savedSettings] = await Promise.all([
      db.episodes.orderBy('createdAt').reverse().limit(30).toArray(),
      getUnreadQueue(500),
      getSettings(),
    ]);
    setEpisodes(eps);
    setQueue(unread);
    setSettings(savedSettings);
    setSelectedEpisodeId((prev) => {
      if (prev && eps.some((e) => e.id === prev)) return prev;
      return eps[0]?.id || null;
    });
  }, []);

  useEffect(() => {
    void refreshData();
    void refreshTabGroups();

    chrome.runtime
      .sendMessage({ type: 'GET_PLAYBACK_STATE' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.state) setPlayback(res.state);
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({ type: 'GET_JOB_STATUS' } satisfies RuntimeRequest)
      .then((res) => {
        if (res?.ok) {
          setIsJobRunning(Boolean(res.isJobRunning));
          if (res.message) setBusyMessage(res.message);
          if (typeof res.progressPercent === 'number') setJobProgressPercent(res.progressPercent);
          if (typeof res.jobStartedAt === 'number') setJobStartedAt(res.jobStartedAt);
          if (typeof res.estimatedRemainingSec === 'number') {
            setJobEstimatedRemainingSec(res.estimatedRemainingSec);
          }
          if (res.lastError) setErrorBanner(res.lastError);
          setIsResynthRunning(Boolean(res.isResynthRunning));
          if (res.resynthMessage) setResynthMessage(res.resynthMessage);
        }
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({ type: 'GET_DEV_BUILD_STATUS' } satisfies RuntimeRequest)
      .then((res: { status?: DevBuildStatus }) => {
        if (res?.status?.currentBuild) setCurrentBuild(res.status.currentBuild);
        if (res?.status?.pendingBuild) setPendingBuild(res.status.pendingBuild);
      })
      .catch(() => {});

    const onRuntimeMessage = (msg: Record<string, unknown>) => {
      if (msg?.type === 'PLAYBACK_STATE_UPDATED' && msg.state) {
        const nextState = msg.state as PlaybackState;
        setPlayback(nextState);
        if (nextState.episodeId) {
          setSelectedEpisodeId(nextState.episodeId);
        }
      } else if (msg?.type === 'EPISODES_UPDATED') {
        void db.episodes
          .orderBy('createdAt')
          .reverse()
          .limit(30)
          .toArray()
          .then((eps) => {
            setEpisodes(eps);
            if (typeof msg.episodeId === 'string' && eps.some((e) => e.id === msg.episodeId)) {
              setSelectedEpisodeId(msg.episodeId);
            } else {
              setSelectedEpisodeId((prev) =>
                prev && eps.some((e) => e.id === prev) ? prev : eps[0]?.id || null
              );
            }
          });
      } else if (msg?.type === 'QUEUE_UPDATED') {
        void getUnreadQueue(500).then(setQueue);
      } else if (msg?.type === 'PATROL_PROGRESS') {
        setBusyMessage(typeof msg.message === 'string' ? msg.message : '');
        if (typeof msg.isJobRunning === 'boolean') {
          setIsJobRunning(msg.isJobRunning);
        }
        if (typeof msg.progressPercent === 'number' || msg.progressPercent === null) {
          setJobProgressPercent(msg.progressPercent as number | null);
        }
        if (typeof msg.jobStartedAt === 'number' || msg.jobStartedAt === null) {
          setJobStartedAt(msg.jobStartedAt as number | null);
        }
        if (typeof msg.estimatedRemainingSec === 'number' || msg.estimatedRemainingSec === null) {
          setJobEstimatedRemainingSec(msg.estimatedRemainingSec as number | null);
        }
      } else if (msg?.type === 'RESYNTH_PROGRESS') {
        setResynthMessage(typeof msg.message === 'string' ? msg.message : '');
        if (typeof msg.isResynthRunning === 'boolean') {
          setIsResynthRunning(msg.isResynthRunning);
        }
      } else if (msg?.type === 'RESYNTH_ERROR' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
        setIsResynthRunning(false);
        setResynthMessage('');
      } else if (msg?.type === 'RESYNTH_FINISHED') {
        setIsResynthRunning(false);
        setResynthMessage('');
        void refreshData();
      } else if (msg?.type === 'JOB_ERROR' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
        setIsJobRunning(false);
        setBusyMessage('');
        setJobProgressPercent(null);
        setJobStartedAt(null);
        setJobEstimatedRemainingSec(null);
      } else if (msg?.type === 'JOB_WARNING' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
      } else if (msg?.type === 'JOB_FINISHED') {
        setIsJobRunning(false);
        setBusyMessage('');
        setJobProgressPercent(null);
        setJobStartedAt(null);
        setJobEstimatedRemainingSec(null);
        void refreshData();
        void refreshTabGroups();
      } else if (msg?.type === 'DEV_BUILD_UPDATE_AVAILABLE' && msg.pendingBuild) {
        setPendingBuild(msg.pendingBuild as BuildMeta);
      } else if (msg?.type === 'GEMINI_KEY_SETUP_DONE') {
        void getSettings().then(setSettings);
        setErrorBanner('');
        const text =
          typeof msg.message === 'string'
            ? msg.message
            : 'Gemini API キーを設定しました！';
        setKeyVerifyStatus({ ok: true, text });
        showToast(text);
      } else if (msg?.type === 'OPENAI_KEY_SETUP_DONE') {
        void getSettings().then(setSettings);
        setErrorBanner('');
        const text =
          typeof msg.message === 'string'
            ? msg.message
            : 'OpenAI API キーを設定しました！';
        setOpenAiKeyVerifyStatus({ ok: true, text });
        showToast(text);
      }
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, [refreshData, refreshTabGroups, showToast]);

  useEffect(() => {
    if (playback.isPlaying && activeTurnRef.current) {
      activeTurnRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [playback.turnIndex, playback.chapterIndex, playback.isPlaying]);

  const displayedEpisode = useMemo(() => {
    return episodes.find((e) => e.id === selectedEpisodeId) || episodes[0] || null;
  }, [episodes, selectedEpisodeId]);

  const isSelectedPlayingEpisode = Boolean(
    displayedEpisode && playback.episodeId === displayedEpisode.id
  );
  const displayedChapterIndex = isSelectedPlayingEpisode ? playback.chapterIndex : 0;
  const displayedChapter =
    displayedEpisode?.chapters[displayedChapterIndex] || displayedEpisode?.chapters[0] || null;

  const hasAudioExportable = Boolean(
    displayedEpisode?.chapters.some((ch) => ch.hasAudioBlob)
  );

  const staleCount = useMemo(
    () =>
      episodes.filter(
        (e) =>
          e.status === 'error' ||
          (!isJobRunning &&
            (e.status === 'generating_script' ||
              e.status === 'synthesizing_audio' ||
              e.status === 'collecting'))
      ).length,
    [episodes, isJobRunning]
  );

  const handlePatchSettings = async (patch: Partial<ExtensionSettings>) => {
    if (patch.autoScheduleEnabled && !(await ensureHostPermissionsForUrls(patrolPermissionUrls(settings)))) {
      setErrorBanner('定時巡回に必要なサイトへのアクセスが許可されませんでした。');
      return;
    }
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: patch,
      } satisfies RuntimeRequest);
      if (!response?.ok) throw new Error(response?.error || '設定を保存できませんでした。');
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : String(error));
      await refreshData();
    }
  };

  const handleDeleteEpisode = async (episodeId: string) => {
    await chrome.runtime.sendMessage({
      type: 'DELETE_EPISODE',
      episodeId,
    } satisfies RuntimeRequest);
    showToast('エピソードを削除しました');
    await refreshData();
  };

  const handleCleanupStale = async () => {
    const res = await chrome.runtime.sendMessage({
      type: 'CLEANUP_STALE_EPISODES',
    } satisfies RuntimeRequest);
    showToast(`${res?.removed ?? 0} 件の未完了エピソードを整理しました`);
    await refreshData();
  };

  const handleCreateDemo = async () => {
    const res = await chrome.runtime.sendMessage({
      type: 'CREATE_DEMO_EPISODE',
    } satisfies RuntimeRequest);
    if (res?.ok) {
      await refreshData();
      setTab('listen');
      showToast('デモ番組を再生します');
    }
  };

  const handlePlayChapter = async (episodeId: string, chapterIndex = 0) => {
    setSelectedEpisodeId(episodeId);
    await chrome.runtime.sendMessage({
      type: 'PLAY_EPISODE',
      episodeId,
      chapterIndex,
    } satisfies RuntimeRequest);
  };

  const handlePlayPause = async () => {
    const target = displayedEpisode || episodes[0];
    if (!target) return;
    if (playback.episodeId !== target.id) {
      await handlePlayChapter(target.id, 0);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'TOGGLE_PLAY_PAUSE' } satisfies RuntimeRequest);
  };

  const handleSkipChapter = (delta: 1 | -1) => {
    void chrome.runtime.sendMessage({ type: 'SKIP_CHAPTER', delta } satisfies RuntimeRequest);
  };

  const handleSeekRelative = (deltaSec: number) => {
    void chrome.runtime.sendMessage({
      type: 'SEEK_RELATIVE',
      deltaSec,
    } satisfies RuntimeRequest);
  };

  const handleCycleSpeed = async () => {
    const currentIdx = SPEED_STEPS.findIndex((s) => Math.abs(s - playback.playbackRate) < 0.05);
    const nextRate = SPEED_STEPS[(currentIdx + 1) % SPEED_STEPS.length];
    await chrome.runtime.sendMessage({
      type: 'SET_PLAYBACK_RATE',
      rate: nextRate,
    } satisfies RuntimeRequest);
  };

  const handleDownloadAudio = async () => {
    if (!displayedEpisode) return;
    setIsExporting(true);
    try {
      const ok = await downloadEpisodeAudio(displayedEpisode);
      if (ok) showToast('結合済みポッドキャスト音声を保存しました');
      else setErrorBanner('このエピソードには音声ファイルがありません（HTML/台本保存をご利用ください）。');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadHtml = async () => {
    if (!displayedEpisode) return;
    setIsExporting(true);
    try {
      await downloadPortableHtmlPlayer(displayedEpisode);
      showToast('音声＆台本入りポータブルHTMLを保存しました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyMarkdown = async () => {
    if (!displayedEpisode) return;
    try {
      await copyEpisodeMarkdown(displayedEpisode);
      showToast('台本と参照リンク集（Markdown）をコピーしました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleShareEpisode = async () => {
    if (!displayedEpisode) return;
    setIsExporting(true);
    try {
      const outcome = await shareEpisodeNative(displayedEpisode);
      showToast(
        outcome === 'shared'
          ? '共有シートを開きました'
          : '台本＆リンク集をクリップボードにコピーしました'
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadMp4 = async () => {
    if (!displayedEpisode || isExporting) return;
    setErrorBanner('');
    setIsExporting(true);
    setExportMessage('MP4動画をレンダリング中...');
    try {
      const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setExportMessage(msg));
      if (!rendered) {
        setErrorBanner('音声ファイルがないため MP4 を生成できません。');
        return;
      }
      const url = URL.createObjectURL(rendered.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = rendered.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToast(`MP4動画を保存しました (${rendered.fileName})`);
    } catch (err) {
      setErrorBanner(`MP4生成エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setExportMessage('');
    }
  };

  const handleAutoPublish = async (platforms: ('youtube' | 'x')[]) => {
    if (!displayedEpisode || isExporting || publishStatus?.running) return;
    setErrorBanner('');
    setIsExporting(true);
    const isFullAuto = settings.publish.autoPublishMode !== 'manual_confirm';
    setExportMessage(
      platforms.length === 2
        ? 'YouTube → X.com 自動投稿パイプラインを準備中...'
        : platforms[0] === 'youtube'
        ? 'YouTube 自動公開を準備中...'
        : 'X.com 自動投稿を準備中...'
    );
    try {
      const permissionUrls: string[] = [];
      if (platforms.includes('youtube')) {
        permissionUrls.push(buildYouTubeStudioUploadUrl(settings.publish.youtubeChannelIdOrUrl));
      }
      if (platforms.includes('x')) {
        permissionUrls.push('https://x.com/');
      }
      if (!(await ensureHostPermissionsForUrls(permissionUrls))) {
        throw new Error('投稿先サイト（YouTube Studio / X.com）へのアクセスが許可されませんでした。');
      }

      const res = (await chrome.runtime.sendMessage({
        type: 'AUTO_PUBLISH_EPISODE',
        episodeId: displayedEpisode.id,
        platforms,
        autoSubmit: isFullAuto,
      } satisfies RuntimeRequest)) as { ok?: boolean; error?: string; status?: PublishPipelineStatus };
      if (!res?.ok) throw new Error(res?.error || '自動投稿を開始できませんでした。');
      if (res.status) setPublishStatus(res.status);
      showToast(
        isFullAuto
          ? platforms.length === 2
            ? 'YouTube 公開 → X.com 投稿の自動パイプラインを開始しました'
            : platforms[0] === 'youtube'
            ? 'YouTube 自動公開を開始しました'
            : 'X.com 自動投稿を開始しました'
          : '投稿画面を開きました。右下のガイドからセットできます'
      );
    } catch (err) {
      setErrorBanner(`自動投稿エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setExportMessage('');
    }
  };

  const handleCancelPublish = async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'CANCEL_PUBLISH_PIPELINE',
      } satisfies RuntimeRequest);
      showToast('自動投稿を中止しました');
    } catch {
      // ignore
    }
  };

  const handlePublishToYouTube = () => handleAutoPublish(['youtube']);
  const handlePublishToX = () => handleAutoPublish(['x']);
  const handlePublishBoth = () => handleAutoPublish(['youtube', 'x']);

  const handleStartGeminiKeySetup = async () => {
    setErrorBanner('');
    setKeyVerifyStatus(null);
    try {
      if (!(await ensureHostPermissionsForUrls(['https://aistudio.google.com/apikey']))) {
        throw new Error('AI Studio へのアクセスが許可されませんでした。');
      }
      const res = await chrome.runtime.sendMessage({
        type: 'START_GEMINI_KEY_SETUP',
      } satisfies RuntimeRequest);
      if (res?.ok) {
        showToast('Google AI Studio を開きました。右下のガイドから1クリックで設定できます');
        return;
      }
      throw new Error(res?.error || 'Google AI Studio を開けませんでした。');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyGeminiKey = async () => {
    setIsVerifyingKey(true);
    setKeyVerifyStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VERIFY_GEMINI_KEY',
        apiKey: settings.geminiApiKey,
      } satisfies RuntimeRequest);
      setKeyVerifyStatus({
        ok: Boolean(res?.ok),
        text: res?.message || (res?.ok ? '接続OK' : '接続に失敗しました'),
      });
    } catch (err) {
      setKeyVerifyStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsVerifyingKey(false);
    }
  };

  const handleStartOpenAiKeySetup = async () => {
    setErrorBanner('');
    setOpenAiKeyVerifyStatus(null);
    try {
      if (!(await ensureHostPermissionsForUrls(['https://platform.openai.com/api-keys']))) {
        throw new Error('OpenAI Platform へのアクセスが許可されませんでした。');
      }
      const res = await chrome.runtime.sendMessage({
        type: 'START_OPENAI_KEY_SETUP',
      } satisfies RuntimeRequest);
      if (res?.ok) {
        showToast('OpenAI API Keys を開きました。キーを作成すると自動で連携されます');
        return;
      }
      throw new Error(res?.error || 'OpenAI Platform を開けませんでした。');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleVerifyOpenAiKey = async () => {
    setIsVerifyingOpenAiKey(true);
    setOpenAiKeyVerifyStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VERIFY_OPENAI_KEY',
        apiKey: settings.openaiApiKey,
      } satisfies RuntimeRequest);
      setOpenAiKeyVerifyStatus({
        ok: Boolean(res?.ok),
        text: res?.message || (res?.ok ? '接続OK' : '接続に失敗しました'),
      });
    } catch (err) {
      setOpenAiKeyVerifyStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsVerifyingOpenAiKey(false);
    }
  };

  const handleResynthesizeEpisode = async (req: ResynthesizeRequest) => {
    setErrorBanner('');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'RESYNTHESIZE_EPISODE_AUDIO',
        episodeId: req.episodeId,
        ttsMode: req.ttsMode,
        geminiTtsModel: req.geminiTtsModel,
        openaiTtsModel: req.openaiTtsModel,
        hostAVoice: req.hostAVoice,
        hostBVoice: req.hostBVoice,
        mode: req.mode,
      } satisfies RuntimeRequest);
      if (res?.ok) {
        showToast('同じ台本で別TTSの音声再作成を開始しました');
        return;
      }
      throw new Error(res?.error || '音声の再作成を開始できませんでした。');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOrganizeGeminiNotebook = async () => {
    setErrorBanner('');
    setIsOrganizingGeminiNotebook(true);
    setGeminiNotebookStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ORGANIZE_GEMINI_NOTEBOOK',
        notebookName: 'agentcast',
      } satisfies RuntimeRequest);
      if (res?.ok && res?.result) {
        const r = res.result as {
          notebookName: string;
          createdNotebook: boolean;
          totalScanned: number;
          addedCount: number;
          alreadyCount: number;
          skippedCount: number;
          failedCount: number;
        };
        const createdNote = r.createdNotebook ? '（ノートブック新規作成）' : '';
        const failNote = r.failedCount > 0 ? `・失敗${r.failedCount}件` : '';
        const summary = `完了${createdNote}：${r.addedCount}件を「${r.notebookName}」に追加（既存${r.alreadyCount}件・対象外${r.skippedCount}件${failNote}／全${r.totalScanned}件スキャン）`;
        setGeminiNotebookStatus({ ok: true, text: summary });
        showToast(`過去の台本 ${r.addedCount}件を「${r.notebookName}」ノートブックに整理しました`);
        return;
      }
      const errMsg = res?.error || 'Gemini ノートブックの整理に失敗しました。';
      setGeminiNotebookStatus({ ok: false, text: errMsg });
      setErrorBanner(errMsg);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setGeminiNotebookStatus({ ok: false, text: errMsg });
      setErrorBanner(errMsg);
    } finally {
      setIsOrganizingGeminiNotebook(false);
    }
  };

  const enabledSourceCount = useMemo(() => {
    const removed = new Set(settings.removedBuiltinSources || []);
    const builtinEnabled = PATROL_SOURCE_IDS.filter(
      (id) => !removed.has(id) && settings.enabledSources[id]
    ).length;
    const customEnabled = (settings.customSites || []).filter((s) => s.enabled).length;
    return builtinEnabled + customEnabled;
  }, [settings.enabledSources, settings.removedBuiltinSources, settings.customSites]);

  const isEngineReady = useMemo(() => {
    const aiReady =
      settings.aiMode === 'web_chatgpt' ||
      settings.aiMode === 'web_gemini' ||
      (settings.aiMode === 'gemini_api' && Boolean(settings.geminiApiKey.trim())) ||
      (settings.aiMode === 'openai_api' && Boolean(settings.openaiApiKey.trim()));
    const ttsReady =
      settings.ttsMode === 'macos_speech' ||
      (settings.ttsMode === 'gemini_tts' && Boolean(settings.geminiApiKey.trim())) ||
      (settings.ttsMode === 'openai_tts' && Boolean(settings.openaiApiKey.trim()));
    return aiReady && ttsReady;
  }, [settings.aiMode, settings.ttsMode, settings.geminiApiKey, settings.openaiApiKey]);

  const handlePatrolAndPlay = async () => {
    setErrorBanner('');
    if (enabledSourceCount === 0) {
      setTab('sources');
      setSourcesSubTab('patrol');
      setErrorBanner('巡回ソースを1つ以上有効にしてください。');
      return;
    }
    if (!isEngineReady) {
      setTab('settings');
      setErrorBanner('AI / 音声エンジンの設定を完了してください。');
      return;
    }
    const msg: RuntimeRequest = { type: 'PATROL_AND_GENERATE', autoPlay: true };
    try {
      if (!(await requestPatrolPermissions(msg, settings))) {
        setErrorBanner('対象サイトへのアクセスが許可されませんでした。');
        return;
      }
      const res = await chrome.runtime.sendMessage(msg);
      if (!res?.ok) {
        setErrorBanner(res?.error || '番組作成の開始に失敗しました。');
        return;
      }
      setTab('listen');
      showToast('巡回から番組作成・再生を開始しました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveQueueItem = async (id: string) => {
    await db.feedItems.delete(id);
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const handleClearQueue = async () => {
    const ids = queue.map((i) => i.id);
    await db.feedItems.bulkDelete(ids);
    setQueue([]);
    showToast('未読キューをクリアしました');
  };

  const miniEpisode =
    (playback.episodeId && episodes.find((e) => e.id === playback.episodeId)) || displayedEpisode;
  const activeTheme: AppThemeId = settings.theme || 'braun';

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-row">
          <h1 className="brand-title">
            <span
              className={`brand-mark ${playback.isPlaying ? 'is-live' : ''}`}
              aria-hidden="true"
            />
            agentCast
            <span className="version-pill">
              v{typeof __AGENTCAST_VERSION__ !== 'undefined' ? __AGENTCAST_VERSION__ : 'dev'}
            </span>
          </h1>
          <div className="header-right-tools">
            {staleCount > 0 && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void handleCleanupStale()}
                title="中断された未完了エピソードを一括削除"
              >
                整理 ({staleCount})
              </button>
            )}
            {pendingBuild && (
              <button
                type="button"
                className="reload-notice-btn"
                onClick={() =>
                  chrome.runtime.sendMessage({
                    type: 'TRIGGER_DEV_RELOAD_NOW',
                  } satisfies RuntimeRequest)
                }
              >
                更新反映
              </button>
            )}
            <div className="theme-dots" role="radiogroup" aria-label="テーマ切替">
              {APP_THEMES.map((t) => {
                const isActive = activeTheme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    className={`theme-dot-btn ${isActive ? 'is-active' : ''}`}
                    style={{ background: t.swatchBg }}
                    title={`テーマ: ${t.name}（${t.labelJa}）`}
                    aria-label={`テーマを ${t.name} に変更`}
                    onClick={() => void handlePatchSettings({ theme: t.id })}
                  >
                    <span className="theme-dot-accent" style={{ background: t.swatchAccent }} />
                  </button>
                );
              })}
            </div>
            <button
              id="btn-open-help"
              type="button"
              className="header-help-btn"
              title="使い方ガイドを開く"
              aria-label="使い方ガイドを開く"
              onClick={() => {
                const url = chrome.runtime.getURL('help.html');
                if (chrome.tabs?.create) {
                  void chrome.tabs.create({ url });
                } else {
                  window.open(url, '_blank', 'noopener');
                }
              }}
            >
              ?
            </button>
          </div>
        </div>

        {/* Calm 3-Tab Editorial Navigation */}
        <nav className="nav-tabs" aria-label="メインナビゲーション">
          <button
            id="tab-listen"
            type="button"
            className={`nav-tab ${tab === 'listen' ? 'is-active' : ''}`}
            onClick={() => setTab('listen')}
          >
            <span>聴く</span>
            {episodes.length > 0 && <span className="nav-count">{episodes.length}</span>}
          </button>
          <button
            id="tab-sources"
            type="button"
            className={`nav-tab ${tab === 'sources' ? 'is-active' : ''}`}
            onClick={() => setTab('sources')}
          >
            <span>巡回</span>
            {queue.length > 0 && <span className="nav-count">{queue.length}</span>}
          </button>
          <button
            id="tab-settings"
            type="button"
            className={`nav-tab ${tab === 'settings' ? 'is-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            <span>設定</span>
          </button>
        </nav>
      </header>

      {((isJobRunning && tab !== 'listen') ||
        toastMessage ||
        resynthMessage ||
        exportMessage ||
        publishStatus?.running ||
        errorBanner ||
        displayedEpisode?.errorMessage) && (
        <div className="banner-stack">
          {isJobRunning && tab !== 'listen' && (
            <div className="global-job-banner" role="status">
              <div className="global-job-banner-row">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className="icon-spin"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="5.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="22 12"
                  />
                </svg>
                <span className="global-job-banner-text">
                  {busyMessage || 'バックグラウンドで作成中…'}
                </span>
                <span className="job-progress-pct">
                  {typeof jobProgressPercent === 'number' ? `${Math.round(jobProgressPercent)}%` : '…'}
                </span>
              </div>
              <div className="job-progress-bar">
                <div
                  className="job-progress-fill"
                  style={{
                    width: `${typeof jobProgressPercent === 'number' ? Math.max(5, Math.min(100, Math.round(jobProgressPercent))) : 15}%`,
                  }}
                />
              </div>
              {formatRemainingTime(jobEstimatedRemainingSec) && (
                <div className="job-progress-meta">
                  <span>バックグラウンド実行中（閉じても継続します）</span>
                  <span>{formatRemainingTime(jobEstimatedRemainingSec)}</span>
                </div>
              )}
            </div>
          )}
          {toastMessage && (
            <div className="status-banner" role="status">
              <span>{toastMessage}</span>
            </div>
          )}
          {resynthMessage && resynthMessage !== displayedEpisode?.statusDetail && (
            <div className="status-banner" role="status">
              <span>{resynthMessage}</span>
            </div>
          )}
          {exportMessage && (
            <div className="status-banner" role="status">
              <span>{exportMessage}</span>
            </div>
          )}
          {publishStatus?.running && (
            <div className="status-banner" role="status">
              <span>{publishStatus.message || '自動投稿を実行中...'}</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void handleCancelPublish()}
                aria-label="自動投稿を中止"
              >
                中止
              </button>
            </div>
          )}
          {(errorBanner || displayedEpisode?.errorMessage) && (
            <div className="status-banner is-error" role="alert">
              <span>{errorBanner || displayedEpisode?.errorMessage}</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setErrorBanner('')}
                aria-label="エラー表示を閉じる"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      <main className="studio-main">
        {tab === 'listen' && (
          <PlayerPanel
            episodes={episodes}
            displayedEpisode={displayedEpisode}
            displayedChapter={displayedChapter}
            displayedChapterIndex={displayedChapterIndex}
            isSelectedPlayingEpisode={isSelectedPlayingEpisode}
            playback={playback}
            settings={settings}
            isJobRunning={isJobRunning}
            isResynthRunning={isResynthRunning}
            hasAudioExportable={hasAudioExportable}
            isExporting={isExporting}
            isPublishing={Boolean(publishStatus?.running)}
            activeTurnRef={activeTurnRef}
            formatSec={formatSec}
            formatEpisodeTimestamp={formatEpisodeTimestamp}
            deriveEpisodeSubtitle={deriveEpisodeSubtitle}
            onSelectEpisode={(id) => setSelectedEpisodeId(id)}
            onPlayEpisode={(id, ch) => void handlePlayChapter(id, ch)}
            onTogglePlayPause={() => void handlePlayPause()}
            onSkipChapter={handleSkipChapter}
            onSeekRelative={handleSeekRelative}
            onCycleSpeed={() => void handleCycleSpeed()}
            onDeleteEpisode={(id) => void handleDeleteEpisode(id)}
            onResynthesizeEpisode={handleResynthesizeEpisode}
            onStartGeminiKeySetup={handleStartGeminiKeySetup}
            onStartOpenAiKeySetup={handleStartOpenAiKeySetup}
            onDownloadAudio={() => void handleDownloadAudio()}
            onDownloadHtml={() => void handleDownloadHtml()}
            onCopyMarkdown={() => void handleCopyMarkdown()}
            onShareNative={() => void handleShareEpisode()}
            onPublishYouTube={() => void handlePublishToYouTube()}
            onPublishX={() => void handlePublishToX()}
            onPublishBoth={() => void handlePublishBoth()}
            onDownloadMp4={() => void handleDownloadMp4()}
            onCreateDemo={() => void handleCreateDemo()}
            onGoToPatrol={() => {
              setTab('sources');
              setSourcesSubTab('patrol');
            }}
            enabledSourceCount={enabledSourceCount}
            isEngineReady={isEngineReady}
            busyMessage={busyMessage}
            jobProgressPercent={jobProgressPercent}
            jobStartedAt={jobStartedAt}
            jobEstimatedRemainingSec={jobEstimatedRemainingSec}
            onPatrolAndPlay={() => void handlePatrolAndPlay()}
            onGoToSettings={() => setTab('settings')}
            onPatchFocusTopics={(focusTopics) => void handlePatchSettings({ focusTopics })}
          />
        )}

        {tab === 'sources' && (
          <div className="step-section">
            <div className="segmented segmented-2" role="tablist" aria-label="巡回とキュー切替">
              <button
                type="button"
                role="tab"
                aria-selected={sourcesSubTab === 'patrol'}
                className={`segment ${sourcesSubTab === 'patrol' ? 'is-active' : ''}`}
                onClick={() => setSourcesSubTab('patrol')}
              >
                巡回ソース ({enabledSourceCount})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourcesSubTab === 'queue'}
                className={`segment ${sourcesSubTab === 'queue' ? 'is-active' : ''}`}
                onClick={() => setSourcesSubTab('queue')}
              >
                素材キュー ({queue.length})
              </button>
            </div>

            {sourcesSubTab === 'patrol' ? (
              <PatrolPanel
                settings={settings}
                isJobRunning={isJobRunning}
                queueCount={queue.length}
                tabGroups={tabGroups}
                selectedGroupId={selectedGroupId}
                onSelectGroupId={(id) => setSelectedGroupId(id)}
                onRefreshTabGroups={refreshTabGroups}
                onClearQueue={handleClearQueue}
                onPatchSettings={handlePatchSettings}
                onGoToQueue={() => setSourcesSubTab('queue')}
                onPatrolAndPlay={() => void handlePatrolAndPlay()}
                showToast={showToast}
                setErrorBanner={setErrorBanner}
              />
            ) : (
              <QueuePanel
                queue={queue}
                settings={settings}
                isJobRunning={isJobRunning}
                onRemoveItem={handleRemoveQueueItem}
                onClearQueue={handleClearQueue}
                onGoToPatrol={() => setSourcesSubTab('patrol')}
                onGoToPlayer={() => setTab('listen')}
                onPatchFocusTopics={(focusTopics) => void handlePatchSettings({ focusTopics })}
                showToast={showToast}
                setErrorBanner={setErrorBanner}
              />
            )}
          </div>
        )}

        {tab === 'settings' && (
          <SettingsPanel
            settings={settings}
            currentBuild={currentBuild}
            pendingBuild={pendingBuild}
            isJobRunning={isJobRunning}
            isVerifyingKey={isVerifyingKey}
            keyVerifyStatus={keyVerifyStatus}
            isVerifyingOpenAiKey={isVerifyingOpenAiKey}
            openAiKeyVerifyStatus={openAiKeyVerifyStatus}
            isOrganizingGeminiNotebook={isOrganizingGeminiNotebook}
            geminiNotebookStatus={geminiNotebookStatus}
            onPatchSettings={handlePatchSettings}
            onStartGeminiKeySetup={handleStartGeminiKeySetup}
            onVerifyGeminiKey={handleVerifyGeminiKey}
            onStartOpenAiKeySetup={handleStartOpenAiKeySetup}
            onVerifyOpenAiKey={handleVerifyOpenAiKey}
            onOrganizeGeminiNotebook={handleOrganizeGeminiNotebook}
            onCreateDemo={handleCreateDemo}
            onGoToPatrol={() => {
              setTab('sources');
              setSourcesSubTab('patrol');
            }}
            onRevokeConsent={
              onRevokeConsent
                ? () => {
                    void onRevokeConsent().catch(() =>
                      setErrorBanner('同意を取り消せませんでした。')
                    );
                  }
                : undefined
            }
          />
        )}
      </main>

      {/* Persistent Minimal Mini-Player when on Sources / Settings */}
      {tab !== 'listen' && miniEpisode && (
        <footer className="mini-player" aria-label="ミニプレイヤー">
          <button
            type="button"
            className="mini-player-info"
            onClick={() => setTab('listen')}
          >
            <span
              className={`deck-led ${playback.isPlaying ? 'is-live' : ''}`}
              aria-hidden="true"
            />
            <span className="mini-texts">
              <span className="mini-title">{miniEpisode.title}</span>
              <span className="mini-status">
                {playback.isPlaying
                  ? `${formatSec(playback.currentTimeSec)} / ${formatSec(playback.durationSec || miniEpisode.totalDurationSec)}`
                  : `一時停止 · ${formatSec(miniEpisode.totalDurationSec)}`}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="btn-primary mini-play-btn"
            onClick={() => void handlePlayPause()}
            aria-label={playback.isPlaying ? '一時停止' : '再生'}
          >
            {playback.isPlaying ? '⏸' : '▶'}
          </button>
        </footer>
      )}
    </div>
  );
}
