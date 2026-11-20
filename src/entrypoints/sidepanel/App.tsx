import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db, getSettings, getUnreadQueue } from '../../storage/db';
import {
  DEFAULT_SETTINGS,
  INITIAL_PLAYBACK_STATE,
  type BuildMeta,
  type ExtensionSettings,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type TabGroupSummary,
} from '../../shared/types';
import type { DevBuildStatus, PendingPublishJob, RuntimeRequest } from '../../shared/messages';
import {
  DATA_CONSENT_KEY,
  DATA_CONSENT_REQUIRED,
  DATA_CONSENT_VERSION,
  hasCurrentDataConsent,
  hasDataConsent,
  PRIVACY_POLICY_URL,
} from '../../shared/data-consent';
import { ensureHostPermissionsForUrls, patrolPermissionUrls } from '../../shared/permissions';
import {
  copyEpisodeMarkdown,
  downloadEpisodeAudio,
  downloadPortableHtmlPlayer,
  shareEpisodeNative,
} from '../../shared/export-utils';
import {
  blobToBase64,
  buildXPostPayload,
  buildYouTubeMetadata,
  buildYouTubeStudioUploadUrl,
  renderEpisodeToMp4,
} from '../../shared/publish-utils';
import { SettingsPanel } from './SettingsPanel';
import { PatrolPanel } from './PatrolPanel';
import { QueuePanel } from './QueuePanel';
import { PlayerPanel } from './PlayerPanel';

type ActiveTab = 'settings' | 'patrol' | 'queue' | 'player';

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
  const [tab, setTab] = useState<ActiveTab>('patrol');
  const [didInitTab, setDidInitTab] = useState(false);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [queue, setQueue] = useState<FeedItem[]>([]);
  const [tabGroups, setTabGroups] = useState<TabGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | ''>('');
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK_STATE);
  const [isJobRunning, setIsJobRunning] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [currentBuild, setCurrentBuild] = useState<BuildMeta | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildMeta | null>(null);
  const [isVerifyingKey, setIsVerifyingKey] = useState<boolean>(false);
  const [keyVerifyStatus, setKeyVerifyStatus] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const activeTurnRef = useRef<HTMLDivElement | null>(null);

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
      getUnreadQueue(80),
      getSettings(),
    ]);
    setEpisodes(eps);
    setQueue(unread);
    setSettings(savedSettings);
    setSelectedEpisodeId((prev) => {
      if (prev && eps.some((e) => e.id === prev)) return prev;
      return eps[0]?.id || null;
    });

    if (!didInitTab) {
      setDidInitTab(true);
      const aiNeedsSetup =
        (savedSettings.aiMode === 'gemini_api' && !savedSettings.geminiApiKey.trim()) ||
        (savedSettings.aiMode === 'openai_api' && !savedSettings.openaiApiKey.trim());
      if (aiNeedsSetup) {
        setTab('settings');
      } else if (eps.length > 0) {
        setTab('player');
      } else {
        setTab('patrol');
      }
    }
  }, [didInitTab]);

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
          if (res.lastError) setErrorBanner(res.lastError);
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
        void getUnreadQueue(80).then(setQueue);
      } else if (msg?.type === 'PATROL_PROGRESS') {
        setBusyMessage(typeof msg.message === 'string' ? msg.message : '');
        if (typeof msg.isJobRunning === 'boolean') {
          setIsJobRunning(msg.isJobRunning);
        }
      } else if (msg?.type === 'JOB_ERROR' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
        setIsJobRunning(false);
        setBusyMessage('');
      } else if (msg?.type === 'JOB_WARNING' && typeof msg.message === 'string') {
        setErrorBanner(msg.message);
      } else if (msg?.type === 'JOB_FINISHED') {
        setIsJobRunning(false);
        setBusyMessage('');
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
      setTab('player');
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
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setIsExporting(true);
    setBusyMessage('MP4動画をレンダリング中...');
    try {
      const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setBusyMessage(msg));
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
      setBusyMessage('');
    }
  };

  const handlePublishToYouTube = async () => {
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setIsExporting(true);
    setBusyMessage('YouTube 公開用 MP4 動画を準備中...');
    try {
      const targetUrl = buildYouTubeStudioUploadUrl(settings.publish.youtubeChannelIdOrUrl);
      if (!(await ensureHostPermissionsForUrls([targetUrl]))) {
        throw new Error('YouTube Studio へのアクセスが許可されませんでした。');
      }
      let videoBase64: string | undefined;
      let fileName: string | undefined;
      if (hasAudioExportable) {
        const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setBusyMessage(msg));
        if (rendered) {
          fileName = rendered.fileName;
          setBusyMessage('YouTube Studio へ転送準備中...');
          videoBase64 = await blobToBase64(rendered.blob);
        }
      }
      const ytMeta = buildYouTubeMetadata(displayedEpisode, settings.publish);
      const job: PendingPublishJob = {
        id: `pub-yt-${Date.now()}`,
        platform: 'youtube',
        targetUrl,
        title: ytMeta.title,
        description: ytMeta.description,
        postText: '',
        threadReplyText: '',
        visibility: settings.publish.youtubeDefaultVisibility,
        channelName: settings.publish.youtubeChannelName,
        fileName,
        mimeType: 'video/mp4',
        videoBase64,
        createdAt: Date.now(),
      };
      const res = await chrome.runtime.sendMessage({
        type: 'START_PUBLISH_JOB',
        job,
      } satisfies RuntimeRequest);
      if (!res?.ok) throw new Error(res?.error || 'YouTube Studio を開けませんでした。');
      showToast('YouTube Studio を開きました。右下の公開ガイドからセットできます');
    } catch (err) {
      setErrorBanner(`YouTube 公開準備エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setBusyMessage('');
    }
  };

  const handlePublishToX = async () => {
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setIsExporting(true);
    setBusyMessage('X.com 投稿データを準備中...');
    try {
      if (!(await ensureHostPermissionsForUrls(['https://x.com/']))) {
        throw new Error('X へのアクセスが許可されませんでした。');
      }
      let videoBase64: string | undefined;
      let fileName: string | undefined;
      if (settings.publish.xAttachVideo && hasAudioExportable) {
        const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setBusyMessage(msg));
        if (rendered) {
          fileName = rendered.fileName;
          setBusyMessage('X.com へ転送準備中...');
          videoBase64 = await blobToBase64(rendered.blob);
        }
      }
      const xPayload = buildXPostPayload(displayedEpisode, settings.publish);
      const targetUrl = `https://x.com/compose/post?text=${encodeURIComponent(xPayload.postText)}`;
      const job: PendingPublishJob = {
        id: `pub-x-${Date.now()}`,
        platform: 'x',
        targetUrl,
        title: displayedEpisode.title,
        description: '',
        postText: xPayload.postText,
        threadReplyText: xPayload.threadReplyText,
        expectedXHandle: settings.publish.xAccountHandle,
        fileName,
        mimeType: 'video/mp4',
        videoBase64,
        createdAt: Date.now(),
      };
      const res = await chrome.runtime.sendMessage({
        type: 'START_PUBLISH_JOB',
        job,
      } satisfies RuntimeRequest);
      if (!res?.ok) throw new Error(res?.error || 'X を開けませんでした。');
      showToast('X.com の投稿画面を開きました');
    } catch (err) {
      setErrorBanner(`X.com 投稿準備エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setBusyMessage('');
    }
  };

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

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-row">
          <h1 className="brand-title">
            <span className="brand-emblem" aria-hidden="true">
              🎧
            </span>
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
          </div>
        </div>

        {/* Unified 4-Step Workflow Nav (Left -> Right) */}
        <nav className="nav-tabs" aria-label="4ステップナビゲーション">
          <button
            id="tab-settings"
            type="button"
            className={`nav-tab ${tab === 'settings' ? 'is-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            <span className="nav-step">STEP 1</span>
            <span>設定</span>
          </button>
          <button
            id="tab-patrol"
            type="button"
            className={`nav-tab ${tab === 'patrol' ? 'is-active' : ''}`}
            onClick={() => setTab('patrol')}
          >
            <span className="nav-step">STEP 2</span>
            <span>巡回</span>
          </button>
          <button
            id="tab-queue"
            type="button"
            className={`nav-tab ${tab === 'queue' ? 'is-active' : ''}`}
            onClick={() => setTab('queue')}
          >
            <span className="nav-step">STEP 3</span>
            <span>キュー ({queue.length})</span>
          </button>
          <button
            id="tab-player"
            type="button"
            className={`nav-tab ${tab === 'player' ? 'is-active' : ''}`}
            onClick={() => setTab('player')}
          >
            <span className="nav-step">STEP 4</span>
            <span>再生</span>
          </button>
        </nav>

        {(busyMessage || toastMessage || displayedEpisode?.statusDetail) && (
          <div className="status-banner" role="status">
            <span>{busyMessage || toastMessage || displayedEpisode?.statusDetail}</span>
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
      </header>

      <main className="studio-main">
        {tab === 'settings' && (
          <SettingsPanel
            settings={settings}
            currentBuild={currentBuild}
            pendingBuild={pendingBuild}
            isVerifyingKey={isVerifyingKey}
            keyVerifyStatus={keyVerifyStatus}
            onPatchSettings={handlePatchSettings}
            onStartGeminiKeySetup={handleStartGeminiKeySetup}
            onVerifyGeminiKey={handleVerifyGeminiKey}
            onCreateDemo={handleCreateDemo}
            onGoToPatrol={() => setTab('patrol')}
            onRevokeConsent={onRevokeConsent ? () => {
              void onRevokeConsent().catch(() => setErrorBanner('同意を取り消せませんでした。'));
            } : undefined}
          />
        )}

        {tab === 'patrol' && (
          <PatrolPanel
            settings={settings}
            isJobRunning={isJobRunning}
            tabGroups={tabGroups}
            selectedGroupId={selectedGroupId}
            onSelectGroupId={(id) => setSelectedGroupId(id)}
            onRefreshTabGroups={refreshTabGroups}
            onPatchSettings={handlePatchSettings}
            onGoToQueue={() => setTab('queue')}
            showToast={showToast}
            setErrorBanner={setErrorBanner}
          />
        )}

        {tab === 'queue' && (
          <QueuePanel
            queue={queue}
            settings={settings}
            isJobRunning={isJobRunning}
            onRemoveItem={handleRemoveQueueItem}
            onClearQueue={handleClearQueue}
            onGoToPatrol={() => setTab('patrol')}
            onGoToPlayer={() => setTab('player')}
            showToast={showToast}
            setErrorBanner={setErrorBanner}
          />
        )}

        {tab === 'player' && (
          <PlayerPanel
            episodes={episodes}
            displayedEpisode={displayedEpisode}
            displayedChapter={displayedChapter}
            displayedChapterIndex={displayedChapterIndex}
            isSelectedPlayingEpisode={isSelectedPlayingEpisode}
            playback={playback}
            isJobRunning={isJobRunning}
            hasAudioExportable={hasAudioExportable}
            isExporting={isExporting}
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
            onDownloadAudio={() => void handleDownloadAudio()}
            onDownloadHtml={() => void handleDownloadHtml()}
            onCopyMarkdown={() => void handleCopyMarkdown()}
            onShareNative={() => void handleShareEpisode()}
            onPublishYouTube={() => void handlePublishToYouTube()}
            onPublishX={() => void handlePublishToX()}
            onDownloadMp4={() => void handleDownloadMp4()}
            onCreateDemo={() => void handleCreateDemo()}
            onGoToPatrol={() => setTab('patrol')}
          />
        )}
      </main>

      {/* Persistent Napster Mini-Player on Steps 1-3 */}
      {tab !== 'player' && miniEpisode && (
        <footer className="mini-player" aria-label="ミニプレイヤー">
          <button
            type="button"
            className="mini-player-info"
            onClick={() => setTab('player')}
          >
            <span className="mini-cover" aria-hidden="true">
              🎧
            </span>
            <span className="mini-texts">
              <span className="mini-title">{miniEpisode.title}</span>
              <span className="mini-status">
                {playback.isPlaying
                  ? `再生中 ・ ${formatSec(playback.currentTimeSec)} / ${formatSec(playback.durationSec || miniEpisode.totalDurationSec)}`
                  : `一時停止 ・ ${formatSec(miniEpisode.totalDurationSec)}`}
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
