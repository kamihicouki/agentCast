import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db, getSettings, getUnreadQueue } from '../../storage/db';
import {
  DEFAULT_SETTINGS,
  EXTRACTION_STRATEGY_META,
  INITIAL_PLAYBACK_STATE,
  PATROL_SOURCE_IDS,
  SOURCE_META,
  type BuildMeta,
  type CustomSiteConfig,
  type ExtensionSettings,
  type ExtractionStrategy,
  type FeedItem,
  type PlaybackState,
  type PodcastEpisode,
  type SourceId,
  type TabGroupSummary,
  type YouTubeVisibility,
} from '../../shared/types';
import type { DevBuildStatus, PendingPublishJob, RuntimeRequest } from '../../shared/messages';
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
import { RadarPanel } from './RadarPanel';

type ActiveTab = 'player' | 'radar' | 'queue' | 'settings';

const SPEED_STEPS = [1.0, 1.25, 1.5, 1.75, 2.0];
const GEMINI_VOICES = ['Puck', 'Aoede', 'Kore', 'Charon', 'Fenrir', 'Leda'];

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

function formatEpisodeOptionLabel(ep: PodcastEpisode): string {
  const ts = formatEpisodeTimestamp(ep.createdAt);
  const sub = deriveEpisodeSubtitle(ep);
  const compactSub = sub.length > 34 ? `${sub.slice(0, 33)}…` : sub;
  const compactTitle = ep.title.length > 26 ? `${ep.title.slice(0, 25)}…` : ep.title;
  return `${ts ? `[${ts}] ` : ''}${compactTitle}${compactSub ? ` — ${compactSub}` : ''}`;
}

const EMPTY_SITE_DRAFT: Omit<CustomSiteConfig, 'id'> = {
  name: '',
  url: '',
  enabled: true,
  passiveEnabled: true,
  extractionStrategy: 'auto',
  cssSelector: '',
  scrollSteps: 0,
  notes: '',
};

export function App() {
  const [tab, setTab] = useState<ActiveTab>('player');
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [queue, setQueue] = useState<FeedItem[]>([]);
  const [tabGroups, setTabGroups] = useState<TabGroupSummary[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | ''>('');
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [playback, setPlayback] = useState<PlaybackState>(INITIAL_PLAYBACK_STATE);
  const [isJobRunning, setIsJobRunning] = useState<boolean>(false);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string>('');
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [currentBuild, setCurrentBuild] = useState<BuildMeta | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildMeta | null>(null);
  const [setupDismissed, setSetupDismissed] = useState<boolean>(false);
  const [isVerifyingKey, setIsVerifyingKey] = useState<boolean>(false);
  const [keyVerifyStatus, setKeyVerifyStatus] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [isSiteEditorOpen, setIsSiteEditorOpen] = useState<boolean>(false);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [siteDraft, setSiteDraft] = useState<Omit<CustomSiteConfig, 'id'>>(EMPTY_SITE_DRAFT);

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

  const isSelectedPlayingEpisode =
    displayedEpisode && playback.episodeId === displayedEpisode.id;

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

  const handleCaptureActiveTab = async () => {
    setErrorBanner('');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CAPTURE_ACTIVE_TAB',
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || 'タブの読み取りに失敗しました');
      } else if (res.warning) {
        setErrorBanner(res.warning);
      } else {
        showToast(`今のタブから ${res.inserted} 件の新着をキューに追加しました`);
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCaptureAndGenerateActiveTab = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'CAPTURE_AND_GENERATE_ACTIVE_TAB',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '現在のタブの番組化を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handlePatrolAndGenerate = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'PATROL_AND_GENERATE',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '番組生成を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handlePatrolTabGroup = async () => {
    if (selectedGroupId === '') return;
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'PATROL_TAB_GROUP',
      groupId: Number(selectedGroupId),
      generateAfter: true,
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || 'タブグループ巡回を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handleGenerateFromQueueOnly = async () => {
    setErrorBanner('');
    setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'GENERATE_EPISODE_FROM_QUEUE',
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || '番組生成を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handleDeleteCurrentEpisode = async () => {
    if (!displayedEpisode) return;
    await chrome.runtime.sendMessage({
      type: 'DELETE_EPISODE',
      episodeId: displayedEpisode.id,
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

  const handleDownloadAudio = async () => {
    if (!displayedEpisode) return;
    try {
      const ok = await downloadEpisodeAudio(displayedEpisode);
      if (ok) {
        showToast('結合済みポッドキャスト音声を保存しました');
      } else {
        setErrorBanner(
          'このエピソードはWeb Speech再生専用のため音声ファイルがありません。HTMLまたはMarkdown保存をご利用ください。'
        );
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadHtml = async () => {
    if (!displayedEpisode) return;
    try {
      await downloadPortableHtmlPlayer(displayedEpisode);
      showToast('音声＆台本入りポータブルHTMLを保存しました');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
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
    try {
      const outcome = await shareEpisodeNative(displayedEpisode);
      showToast(
        outcome === 'shared'
          ? '共有シートを開きました'
          : '台本＆リンク集をクリップボードにコピーしました'
      );
    } catch (err) {
      // User canceling native share sheet is not an error
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadMp4 = async () => {
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setBusyMessage('MP4動画をレンダリング中...');
    try {
      const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setBusyMessage(msg));
      if (!rendered) {
        setErrorBanner(
          'このエピソードは音声ファイルがありません（Gemini TTS または OpenAI TTS で生成した番組をお試しください）。'
        );
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
      setBusyMessage('');
    }
  };

  const handlePublishToYouTube = async () => {
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setBusyMessage('YouTube 公開用 MP4 動画を準備中...');
    try {
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
      const targetUrl = buildYouTubeStudioUploadUrl(settings.publish.youtubeChannelIdOrUrl);
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

      if (!res?.ok) {
        await chrome.tabs.create({ url: targetUrl, active: true });
      }
      showToast('YouTube Studio を開きました。右下の公開ガイドから動画＆概要欄をセットできます');
    } catch (err) {
      setErrorBanner(`YouTube 公開準備エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyMessage('');
    }
  };

  const handlePublishToX = async () => {
    if (!displayedEpisode || isJobRunning) return;
    setErrorBanner('');
    setBusyMessage('X.com 投稿データを準備中...');
    try {
      let videoBase64: string | undefined;
      let fileName: string | undefined;
      if (settings.publish.xAttachVideo && hasAudioExportable) {
        const rendered = await renderEpisodeToMp4(displayedEpisode, (msg) => setBusyMessage(msg));
        if (rendered) {
          fileName = rendered.fileName;
          setBusyMessage('X.com コンポーザーへ転送準備中...');
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

      if (!res?.ok) {
        await chrome.tabs.create({ url: targetUrl, active: true });
      }
      showToast('X.com の投稿画面を開きました。右下のガイドから動画添付＆最終確認ができます');
    } catch (err) {
      setErrorBanner(`X.com 投稿準備エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyMessage('');
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
    if (!displayedEpisode) return;
    if (playback.episodeId !== displayedEpisode.id) {
      await handlePlayChapter(displayedEpisode.id, 0);
      return;
    }
    await chrome.runtime.sendMessage({ type: 'TOGGLE_PLAY_PAUSE' } satisfies RuntimeRequest);
  };

  const handleCycleSpeed = async () => {
    const currentIdx = SPEED_STEPS.findIndex((s) => Math.abs(s - playback.playbackRate) < 0.05);
    const nextRate = SPEED_STEPS[(currentIdx + 1) % SPEED_STEPS.length];
    await chrome.runtime.sendMessage({
      type: 'SET_PLAYBACK_RATE',
      rate: nextRate,
    } satisfies RuntimeRequest);
  };

  const handlePatchSettings = async (patch: Partial<ExtensionSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: patch,
    } satisfies RuntimeRequest);
  };

  const handleStartGeminiKeySetup = async () => {
    setErrorBanner('');
    setKeyVerifyStatus(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'START_GEMINI_KEY_SETUP',
      } satisfies RuntimeRequest);
      if (res?.ok) {
        showToast('Google AI Studio を開きました。右下のガイドから1クリックで設定できます');
        return;
      }
    } catch {
      // Fallback directly below if Service Worker is reloading
    }

    try {
      await chrome.tabs.create({
        url: 'https://aistudio.google.com/apikey',
        active: true,
      });
      showToast('Google AI Studio を開きました。キーをコピー後「📋 貼付＆テスト」を押してください');
    } catch (err) {
      setErrorBanner(
        `Google AI Studio を開けませんでした: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleOpenAddCustomSite = () => {
    setEditingSiteId(null);
    setSiteDraft({ ...EMPTY_SITE_DRAFT });
    setIsSiteEditorOpen(true);
  };

  const handlePrefillCustomSiteFromActiveTab = async () => {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.url || !activeTab.url.startsWith('http')) {
        setErrorBanner('現在のタブは追加できないURLです（https:// ページを開いてお試しください）');
        return;
      }
      const isChangelog = /changelog|release-notes|releases/i.test(activeTab.url);
      setEditingSiteId(null);
      setSiteDraft({
        ...EMPTY_SITE_DRAFT,
        name: (activeTab.title || new URL(activeTab.url).hostname).slice(0, 42),
        url: activeTab.url,
        extractionStrategy: isChangelog ? 'changelog' : 'auto',
      });
      setIsSiteEditorOpen(true);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEditCustomSite = (site: CustomSiteConfig) => {
    setEditingSiteId(site.id);
    setSiteDraft({
      name: site.name,
      url: site.url,
      enabled: site.enabled,
      passiveEnabled: site.passiveEnabled,
      extractionStrategy: site.extractionStrategy,
      cssSelector: site.cssSelector || '',
      scrollSteps: site.scrollSteps ?? 0,
      notes: site.notes || '',
    });
    setIsSiteEditorOpen(true);
  };

  const handleSaveCustomSite = async () => {
    const cleanUrl = siteDraft.url.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) {
      setErrorBanner('URL は https:// または http:// から始まる形式で入力してください。');
      return;
    }
    const cleanName = siteDraft.name.trim() || new URL(cleanUrl).hostname;
    const list = settings.customSites || [];
    const nextSite: CustomSiteConfig = {
      id: editingSiteId || `site-${Date.now()}`,
      name: cleanName,
      url: cleanUrl,
      enabled: siteDraft.enabled,
      passiveEnabled: siteDraft.passiveEnabled,
      extractionStrategy: siteDraft.extractionStrategy,
      cssSelector: siteDraft.cssSelector?.trim() || undefined,
      scrollSteps: Math.max(0, Math.min(3, Number(siteDraft.scrollSteps) || 0)),
      notes: siteDraft.notes?.trim() || undefined,
    };

    const nextList = editingSiteId
      ? list.map((s) => (s.id === editingSiteId ? nextSite : s))
      : [...list, nextSite];

    await handlePatchSettings({ customSites: nextList });
    setIsSiteEditorOpen(false);
    setEditingSiteId(null);
    setSiteDraft({ ...EMPTY_SITE_DRAFT });
    showToast(editingSiteId ? `「${cleanName}」を更新しました` : `「${cleanName}」を追加しました`);
  };

  const handleToggleCustomSite = async (siteId: string, enabled: boolean) => {
    const nextList = (settings.customSites || []).map((s) =>
      s.id === siteId ? { ...s, enabled } : s
    );
    await handlePatchSettings({ customSites: nextList });
  };

  const handleDeleteCustomSite = async (siteId: string) => {
    const nextList = (settings.customSites || []).filter((s) => s.id !== siteId);
    await handlePatchSettings({ customSites: nextList });
    showToast('カスタムサイトを削除しました');
  };

  const handlePatrolCustomSite = async (siteId: string, generateAfter: boolean) => {
    setErrorBanner('');
    if (generateAfter) setTab('player');
    const res = await chrome.runtime.sendMessage({
      type: 'PATROL_CUSTOM_SITE',
      siteId,
      generateAfter,
    } satisfies RuntimeRequest);
    if (!res?.ok) {
      setErrorBanner(res?.error || 'カスタムサイトの巡回を開始できませんでした');
    } else {
      setIsJobRunning(true);
    }
  };

  const handlePasteKeyFromClipboard = async () => {
    setErrorBanner('');
    setIsVerifyingKey(true);
    try {
      const text = await navigator.clipboard.readText();
      const match = /\b(AIza[0-9A-Za-z_-]{35})\b/.exec(text || '');
      if (!match?.[1]) {
        const msg =
          'クリップボードに Gemini API キー（AIza...）が見つかりません。AI Studio でキーをコピーしてから押してください。';
        setKeyVerifyStatus({ ok: false, text: msg });
        setErrorBanner(msg);
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: 'GEMINI_KEY_CAPTURED',
        apiKey: match[1],
      } satisfies RuntimeRequest);
      if (res?.ok) {
        const saved = await getSettings();
        setSettings(saved);
        const msg = res.message || '接続テスト成功！キーを保存しました。';
        setKeyVerifyStatus({ ok: true, text: msg });
        showToast(msg);
      } else {
        const msg = res?.error || 'APIキーの検証に失敗しました';
        setKeyVerifyStatus({ ok: false, text: msg });
        setErrorBanner(msg);
      }
    } catch (err) {
      setErrorBanner(
        `クリップボードの読み取りに失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setIsVerifyingKey(false);
    }
  };

  const handleVerifyGeminiKey = async () => {
    setErrorBanner('');
    setIsVerifyingKey(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'VERIFY_GEMINI_KEY',
        apiKey: settings.geminiApiKey,
      } satisfies RuntimeRequest);
      const text = res?.message || (res?.ok ? '接続テスト成功！' : '接続テストに失敗しました');
      setKeyVerifyStatus({ ok: Boolean(res?.ok), text });
      if (res?.ok) showToast(text);
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
    const ids = queue.map((q) => q.id);
    await db.feedItems.bulkDelete(ids);
    setQueue([]);
  };

  const progressPct =
    isSelectedPlayingEpisode && playback.durationSec > 0
      ? Math.min(100, (playback.currentTimeSec / playback.durationSec) * 100)
      : 0;

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-row">
          <h1 className="brand-title">
            <span className="brand-mark" aria-hidden="true" />
            agentCast
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10.5px',
                fontWeight: 600,
                color: 'var(--text-muted)',
              }}
            >
              v{typeof __AGENTCAST_VERSION__ !== 'undefined' ? __AGENTCAST_VERSION__ : 'dev'}
            </span>
          </h1>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            {staleCount > 0 && (
              <button
                id="btn-cleanup-stale"
                type="button"
                className="btn-ghost"
                onClick={handleCleanupStale}
                title="中断された未完了エピソードを一括削除"
              >
                未完了整理 ({staleCount})
              </button>
            )}
            {pendingBuild && (
              <button
                id="btn-apply-hot-reload"
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

        <div className="action-strip">
          <button
            id="btn-patrol-and-generate"
            type="button"
            className="btn-primary"
            disabled={isJobRunning}
            onClick={handlePatrolAndGenerate}
            title="登録5サイトを専用タブグループで巡回して番組を生成"
          >
            巡回して番組作成
          </button>
          <button
            id="btn-instant-active-tab"
            type="button"
            className="btn-secondary"
            disabled={isJobRunning}
            onClick={handleCaptureAndGenerateActiveTab}
            title="現在開いているページ（Changelogや記事等）だけで即座に1番組を作成"
          >
            今のタブを番組化
          </button>
          <button
            id="btn-capture-active-tab"
            type="button"
            className="btn-secondary"
            disabled={isJobRunning}
            onClick={handleCaptureActiveTab}
            title="現在開いているタブの記事を未読キューに追加"
          >
            ＋キュー
          </button>
        </div>

        {tabGroups.length > 0 && (
          <div className="tabgroup-strip">
            <select
              id="select-tab-group"
              className="episode-select"
              value={selectedGroupId}
              onChange={(e) => setSelectedGroupId(Number(e.target.value))}
              aria-label="巡回するタブグループを選択"
            >
              {tabGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  📁 {g.title} ({g.tabCount}タブ)
                </option>
              ))}
            </select>
            <button
              id="btn-patrol-tab-group"
              type="button"
              className="btn-secondary"
              disabled={isJobRunning || selectedGroupId === ''}
              onClick={handlePatrolTabGroup}
              title="選択したタブグループ内の全タブを巡回して番組を作成"
            >
              グループ番組化
            </button>
            <button
              id="btn-refresh-tab-groups"
              type="button"
              className="btn-ghost"
              onClick={() => void refreshTabGroups()}
              title="タブグループ一覧を更新"
              aria-label="タブグループ一覧を更新"
            >
              ↻
            </button>
          </div>
        )}

        <nav className="nav-tabs" aria-label="メインナビゲーション">
          <button
            id="tab-player"
            type="button"
            className={`nav-tab ${tab === 'player' ? 'is-active' : ''}`}
            onClick={() => setTab('player')}
          >
            再生・台本
          </button>
          <button
            id="tab-radar"
            type="button"
            className={`nav-tab ${tab === 'radar' ? 'is-active' : ''}`}
            onClick={() => setTab('radar')}
          >
            動向
          </button>
          <button
            id="tab-queue"
            type="button"
            className={`nav-tab ${tab === 'queue' ? 'is-active' : ''}`}
            onClick={() => setTab('queue')}
          >
            キュー ({queue.length})
          </button>
          <button
            id="tab-settings"
            type="button"
            className={`nav-tab ${tab === 'settings' ? 'is-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            設定
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
        {tab === 'player' && (
          <>
            {!settings.geminiApiKey.trim() &&
              settings.aiMode === 'gemini_api' &&
              !setupDismissed && (
                <section className="onboarding-card" aria-label="初回APIキーかんたん設定">
                  <div className="onboarding-header">
                    <h2 className="onboarding-title">Google AI Pro / Ultra 初回セットアップ</h2>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setSetupDismissed(true)}
                      aria-label="セットアップ案内を閉じる"
                    >
                      ✕
                    </button>
                  </div>
                  <p className="onboarding-desc">
                    AI Studio
                    を開いてキーを作成・表示するだけで、agentCast
                    が自動検出して保存＆接続テストまで半自動で完了します。
                  </p>
                  <div className="onboarding-actions">
                    <button
                      id="btn-onboarding-start-aistudio"
                      type="button"
                      className="btn-primary"
                      onClick={handleStartGeminiKeySetup}
                    >
                      AI Studio を開いてキーを半自動設定
                    </button>
                    <div className="onboarding-sub-row">
                      <button
                        id="btn-onboarding-paste-key"
                        type="button"
                        className="btn-secondary"
                        disabled={isVerifyingKey}
                        onClick={handlePasteKeyFromClipboard}
                      >
                        {isVerifyingKey ? '接続テスト中...' : '📋 クリップボードから貼付＆テスト'}
                      </button>
                      <button
                        id="btn-onboarding-use-web"
                        type="button"
                        className="btn-ghost"
                        onClick={() =>
                          void handlePatchSettings({
                            aiMode: 'web_gemini',
                            ttsMode: 'macos_speech',
                          })
                        }
                        title="APIキーを使わずにログイン済み Gemini Web セッションで生成"
                      >
                        キーなしWeb連携
                      </button>
                    </div>
                  </div>
                </section>
              )}
            {displayedEpisode ? (
              <>
                <section className="player-deck" aria-label="ポッドキャスト再生デッキ">
                  <div className="episode-picker-row">
                    <select
                      id="select-episode"
                      className="episode-select"
                      value={displayedEpisode.id}
                      onChange={(e) => setSelectedEpisodeId(e.target.value)}
                      aria-label="エピソード選択"
                    >
                      {episodes.map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {formatEpisodeOptionLabel(ep)}
                        </option>
                      ))}
                    </select>
                    <button
                      id="btn-playback-speed"
                      type="button"
                      className="ctrl-btn"
                      onClick={handleCycleSpeed}
                      title="再生速度を切り替え"
                    >
                      {playback.playbackRate.toFixed(2).replace(/\.00$/, '.0')}x
                    </button>
                    <button
                      id="btn-delete-episode"
                      type="button"
                      className="ctrl-btn"
                      onClick={handleDeleteCurrentEpisode}
                      title="このエピソードを削除"
                      aria-label="このエピソードを削除"
                    >
                      🗑
                    </button>
                  </div>

                  <div className="episode-meta-card">
                    <div className="episode-meta-time">
                      <span>{formatEpisodeTimestamp(displayedEpisode.createdAt)}</span>
                      <span>
                        {displayedEpisode.sourceCount}件 · {displayedEpisode.chapters.length}
                        チャプター
                      </span>
                    </div>
                    <div className="episode-meta-title">{displayedEpisode.title}</div>
                    <div className="episode-meta-subtitle">
                      {deriveEpisodeSubtitle(displayedEpisode)}
                    </div>
                  </div>

                  {displayedChapter ? (
                    <>
                      <div className="chapter-kicker">
                        CHAPTER {displayedChapter.index + 1} / {displayedEpisode.chapters.length} ·{' '}
                        {displayedEpisode.ttsEngineLabel}
                      </div>
                      <h2 className="chapter-heading">{displayedChapter.title}</h2>
                      {displayedChapter.summary && (
                        <p className="chapter-sub">{displayedChapter.summary}</p>
                      )}
                    </>
                  ) : (
                    <p className="chapter-sub">{displayedEpisode.subtitle}</p>
                  )}

                  <div className="progress-track" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                  <div className="time-row">
                    <span>
                      {isSelectedPlayingEpisode ? formatSec(playback.currentTimeSec) : '00:00'}
                    </span>
                    <span>
                      {isSelectedPlayingEpisode
                        ? formatSec(playback.durationSec)
                        : formatSec(
                            displayedChapter?.durationSec || displayedEpisode.totalDurationSec
                          )}
                    </span>
                  </div>

                  <div className="transport-row">
                    <button
                      id="btn-prev-chapter"
                      type="button"
                      className="ctrl-btn"
                      onClick={() =>
                        chrome.runtime.sendMessage({
                          type: 'SKIP_CHAPTER',
                          delta: -1,
                        } satisfies RuntimeRequest)
                      }
                      title="前のチャプターへ"
                    >
                      ⏮ 前話
                    </button>

                    <div className="transport-center">
                      <button
                        id="btn-seek-back"
                        type="button"
                        className="ctrl-btn"
                        onClick={() =>
                          chrome.runtime.sendMessage({
                            type: 'SEEK_RELATIVE',
                            deltaSec: -15,
                          } satisfies RuntimeRequest)
                        }
                        title="15秒戻す"
                      >
                        -15s
                      </button>

                      <button
                        id="btn-play-pause"
                        type="button"
                        className="ctrl-btn ctrl-btn-play"
                        onClick={handlePlayPause}
                        aria-label={
                          isSelectedPlayingEpisode && playback.isPlaying ? '一時停止' : '再生'
                        }
                      >
                        {isSelectedPlayingEpisode && playback.isPlaying ? '⏸' : '▶'}
                      </button>

                      <button
                        id="btn-seek-forward"
                        type="button"
                        className="ctrl-btn"
                        onClick={() =>
                          chrome.runtime.sendMessage({
                            type: 'SEEK_RELATIVE',
                            deltaSec: 15,
                          } satisfies RuntimeRequest)
                        }
                        title="15秒進める"
                      >
                        +15s
                      </button>
                    </div>

                    <button
                      id="btn-next-chapter"
                      type="button"
                      className="ctrl-btn"
                      onClick={() =>
                        chrome.runtime.sendMessage({
                          type: 'SKIP_CHAPTER',
                          delta: 1,
                        } satisfies RuntimeRequest)
                      }
                      title="次のチャプターへスキップ（Bluetoothイヤホンの次曲操作に対応）"
                    >
                      次話 ⏭
                    </button>
                  </div>

                  <div className="share-strip" aria-label="番組の保存と共有">
                    <button
                      id="btn-export-audio"
                      type="button"
                      className="share-btn"
                      disabled={!hasAudioExportable}
                      onClick={handleDownloadAudio}
                      title="全チャプターを結合した音声ファイル（WAV/MP3）を保存"
                    >
                      音声保存
                    </button>
                    <button
                      id="btn-export-html"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleDownloadHtml}
                      title="音声＋台本＋リンクが1ファイルに収まった単体プレイヤーHTMLを保存"
                    >
                      HTML保存
                    </button>
                    <button
                      id="btn-copy-markdown"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleCopyMarkdown}
                      title="台本と参照元URLをMarkdown形式でコピー"
                    >
                      台本コピー
                    </button>
                    <button
                      id="btn-share-episode"
                      type="button"
                      className="share-btn"
                      disabled={displayedEpisode.chapters.length === 0}
                      onClick={handleShareEpisode}
                      title="macOS共有シート（AirDrop等）またはクリップボードで共有"
                    >
                      共有 ↗
                    </button>
                  </div>

                  <div className="publish-strip" aria-label="YouTube・X.comへ公開">
                    <button
                      id="btn-publish-youtube"
                      type="button"
                      className="publish-btn"
                      disabled={displayedEpisode.chapters.length === 0 || isJobRunning}
                      onClick={handlePublishToYouTube}
                      title="MP4動画を生成し、設定済みYouTube Studioチャンネルを半自動入力で開く"
                    >
                      📺 YouTube公開
                    </button>
                    <button
                      id="btn-publish-x"
                      type="button"
                      className="publish-btn"
                      disabled={displayedEpisode.chapters.length === 0 || isJobRunning}
                      onClick={handlePublishToX}
                      title="要約ポスト＆動画を準備してX.com投稿画面を開く"
                    >
                      𝕏 Xに投稿
                    </button>
                    <button
                      id="btn-export-mp4"
                      type="button"
                      className="publish-btn"
                      disabled={!hasAudioExportable || isJobRunning}
                      onClick={handleDownloadMp4}
                      title="チャプター表紙＋結合音声のMP4動画をローカルに保存"
                    >
                      🎬 MP4保存
                    </button>
                  </div>

                  <div className="bt-hint">
                    <span>Bluetooth「次の曲」操作 ＝ 次の話題チャプターへスキップ</span>
                  </div>
                </section>

                {displayedEpisode.chapters.length > 1 && (
                  <section className="chapter-strip" aria-label="チャプター一覧">
                    {displayedEpisode.chapters.map((ch) => {
                      const isCurrent = ch.index === displayedChapterIndex;
                      return (
                        <button
                          key={ch.id}
                          type="button"
                          className={`chapter-row-btn ${isCurrent ? 'is-current' : ''}`}
                          onClick={() => handlePlayChapter(displayedEpisode.id, ch.index)}
                        >
                          <span>
                            <span className="chapter-idx">
                              {String(ch.index + 1).padStart(2, '0')}
                            </span>
                            {ch.title}
                          </span>
                          <span className="chapter-idx">{formatSec(ch.durationSec)}</span>
                        </button>
                      );
                    })}
                  </section>
                )}

                {displayedChapter && displayedChapter.sourceItems.length > 0 && (
                  <div className="sources-box" aria-label="参照元リンク">
                    {displayedChapter.sourceItems.map((src) => (
                      <a
                        key={src.id}
                        className="source-link-chip"
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        title={src.title}
                      >
                        <span className="source-tag">
                          {SOURCE_META[src.source]?.shortLabel || src.source}
                        </span>
                        <span className="source-link-title">{src.title}</span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                  </div>
                )}

                {displayedChapter && (
                  <section className="transcript-list" aria-label="番組台本">
                    {displayedChapter.turns.map((turn, idx) => {
                      const isSpeaking =
                        Boolean(isSelectedPlayingEpisode) &&
                        playback.isPlaying &&
                        playback.turnIndex === idx;
                      return (
                        <div
                          key={turn.id}
                          ref={isSpeaking ? activeTurnRef : null}
                          className={`turn-item ${isSpeaking ? 'is-speaking' : ''}`}
                        >
                          <span
                            className={`speaker-label ${
                              turn.speaker === 'HostA' ? 'host-a' : 'host-b'
                            }`}
                          >
                            {turn.speakerName}
                          </span>
                          <p className="turn-text">{turn.text}</p>
                        </div>
                      );
                    })}
                  </section>
                )}
              </>
            ) : (
              <div className="empty-box">
                <p>まだエピソードがありません。</p>
                <button
                  id="btn-create-demo"
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    chrome.runtime.sendMessage({
                      type: 'CREATE_DEMO_EPISODE',
                    } satisfies RuntimeRequest)
                  }
                >
                  サウンドチェック番組を再生する
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'radar' && (
          <RadarPanel
            settings={settings}
            isJobRunning={isJobRunning}
            onPatchSettings={handlePatchSettings}
            showToast={showToast}
            setErrorBanner={setErrorBanner}
          />
        )}

        {tab === 'queue' && (
          <section aria-label="未読ストック一覧">
            <div className="section-toolbar">
              <button
                id="btn-generate-from-queue"
                type="button"
                className="btn-primary"
                disabled={queue.length === 0 || isJobRunning}
                onClick={handleGenerateFromQueueOnly}
              >
                キュー ({queue.length}件) から番組作成
              </button>
              {queue.length > 0 && (
                <button
                  id="btn-clear-queue"
                  type="button"
                  className="btn-ghost"
                  onClick={handleClearQueue}
                >
                  すべてクリア
                </button>
              )}
            </div>

            {queue.length === 0 ? (
              <div className="empty-box">
                <p>
                  未読キューは空です。X・Note・Zenn・Yahoo!・Google Newsを普段通り閲覧するか、「＋キュー」「巡回して番組作成」を押すとここに記事が貯まります。
                </p>
              </div>
            ) : (
              <div className="queue-list">
                {queue.map((item) => (
                  <article key={item.id} className="queue-item">
                    <div className="queue-meta">
                      <span>
                        [{SOURCE_META[item.source]?.shortLabel || item.source}] {item.author}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => handleRemoveQueueItem(item.id)}
                      >
                        除外
                      </button>
                    </div>
                    <h3 className="queue-title">
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.title}
                      </a>
                    </h3>
                    <p className="queue-excerpt">{item.excerpt}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'settings' && (
          <section aria-label="設定">
            <div className="settings-group">
              <h2 className="settings-group-title">AI・音声合成プラン設定</h2>

              <div className="field-row">
                <label className="field-label" htmlFor="select-ai-mode">
                  台本生成エンジン（契約プランに合わせて選択）
                </label>
                <select
                  id="select-ai-mode"
                  className="field-select"
                  value={settings.aiMode}
                  onChange={(e) => {
                    const nextAi = e.target.value as ExtensionSettings['aiMode'];
                    const suggestedTts: ExtensionSettings['ttsMode'] =
                      nextAi === 'gemini_api'
                        ? 'gemini_tts'
                        : nextAi === 'openai_api'
                        ? 'openai_tts'
                        : 'macos_speech';
                    void handlePatchSettings({ aiMode: nextAi, ttsMode: suggestedTts });
                  }}
                >
                  <option value="gemini_api">
                    Google AI Pro/Ultra 推奨：Gemini API 直結 (クレジット/無料枠)
                  </option>
                  <option value="web_chatgpt">
                    ChatGPT Plus/Pro：ログイン済み Web セッション連携 (APIキー不要)
                  </option>
                  <option value="web_gemini">
                    Google AI Pro/Ultra：Gemini Web セッション連携 (APIキー不要)
                  </option>
                  <option value="openai_api">OpenAI API キー直結 (BYOK)</option>
                </select>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="select-tts-mode">
                  音声合成（TTS）エンジン
                </label>
                <select
                  id="select-tts-mode"
                  className="field-select"
                  value={settings.ttsMode}
                  onChange={(e) =>
                    void handlePatchSettings({
                      ttsMode: e.target.value as ExtensionSettings['ttsMode'],
                    })
                  }
                >
                  <option value="gemini_tts">
                    Gemini Multi-Speaker TTS（2人掛け合いネイティブ高音質）
                  </option>
                  <option value="macos_speech">
                    macOS Web Speech（完全無料・APIキー不要で即時再生）
                  </option>
                  <option value="openai_tts">OpenAI Multi-Voice TTS</option>
                </select>
              </div>

              {(settings.aiMode === 'gemini_api' || settings.ttsMode === 'gemini_tts') && (
                <div className="field-row">
                  <label className="field-label" htmlFor="input-gemini-key">
                    Gemini API Key (Google AI Studio / Developer Program特典枠)
                  </label>
                  <input
                    id="input-gemini-key"
                    type="password"
                    className="field-input"
                    placeholder="AIzaSy..."
                    value={settings.geminiApiKey}
                    onChange={(e) => {
                      setKeyVerifyStatus(null);
                      void handlePatchSettings({ geminiApiKey: e.target.value });
                    }}
                  />
                  <div className="key-tools-row">
                    <button
                      id="btn-settings-aistudio-setup"
                      type="button"
                      className="btn-primary"
                      onClick={handleStartGeminiKeySetup}
                    >
                      AI Studio で半自動取得
                    </button>
                    <button
                      id="btn-settings-paste-key"
                      type="button"
                      className="btn-secondary"
                      disabled={isVerifyingKey}
                      onClick={handlePasteKeyFromClipboard}
                    >
                      📋 貼付＆テスト
                    </button>
                    <button
                      id="btn-settings-verify-key"
                      type="button"
                      className="btn-secondary"
                      disabled={isVerifyingKey || !settings.geminiApiKey.trim()}
                      onClick={handleVerifyGeminiKey}
                    >
                      {isVerifyingKey ? '確認中...' : '接続テスト'}
                    </button>
                  </div>
                  {keyVerifyStatus && (
                    <div
                      className={`key-status ${keyVerifyStatus.ok ? 'is-ok' : 'is-err'}`}
                      role="status"
                    >
                      {keyVerifyStatus.text}
                    </div>
                  )}
                  <p className="field-hint">
                    ローカル（chrome.storage.local）にのみ保存されます。Google AI Pro/Ultra
                    の月次クレジットは{' '}
                    <a
                      href="https://developers.google.com/profile"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google Developer Program
                    </a>{' '}
                    から有効化できます。未入力時は音声が自動的に macOS Web Speech
                    へフォールバックします。
                  </p>
                </div>
              )}

              {(settings.aiMode === 'openai_api' || settings.ttsMode === 'openai_tts') && (
                <div className="field-row">
                  <label className="field-label" htmlFor="input-openai-key">
                    OpenAI API Key
                  </label>
                  <input
                    id="input-openai-key"
                    type="password"
                    className="field-input"
                    placeholder="sk-..."
                    value={settings.openaiApiKey}
                    onChange={(e) => void handlePatchSettings({ openaiApiKey: e.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">公開先設定（YouTube / X.com）</h2>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-yt-channel-name">
                    YouTube チャンネル名（確認用）
                  </label>
                  <input
                    id="input-yt-channel-name"
                    type="text"
                    className="field-input"
                    placeholder="例：My Tech Radio"
                    value={settings.publish.youtubeChannelName}
                    onChange={(e) =>
                      void handlePatchSettings({
                        publish: {
                          ...settings.publish,
                          youtubeChannelName: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="select-yt-visibility">
                    デフォルト公開範囲
                  </label>
                  <select
                    id="select-yt-visibility"
                    className="field-select"
                    value={settings.publish.youtubeDefaultVisibility}
                    onChange={(e) =>
                      void handlePatchSettings({
                        publish: {
                          ...settings.publish,
                          youtubeDefaultVisibility: e.target.value as YouTubeVisibility,
                        },
                      })
                    }
                  >
                    <option value="unlisted">限定公開 (Unlisted)</option>
                    <option value="private">非公開 (Private)</option>
                    <option value="public">公開 (Public)</option>
                  </select>
                </div>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="input-yt-channel-url">
                  YouTube チャンネル URL または Channel ID (UC...)
                </label>
                <input
                  id="input-yt-channel-url"
                  type="text"
                  className="field-input"
                  placeholder="https://studio.youtube.com/channel/UC...（空欄ならデフォルトチャンネル）"
                  value={settings.publish.youtubeChannelIdOrUrl}
                  onChange={(e) =>
                    void handlePatchSettings({
                      publish: {
                        ...settings.publish,
                        youtubeChannelIdOrUrl: e.target.value,
                      },
                    })
                  }
                />
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="input-yt-hashtags">
                  YouTube 概要欄ハッシュタグ
                </label>
                <input
                  id="input-yt-hashtags"
                  type="text"
                  className="field-input"
                  value={settings.publish.youtubeHashtags}
                  onChange={(e) =>
                    void handlePatchSettings({
                      publish: {
                        ...settings.publish,
                        youtubeHashtags: e.target.value,
                      },
                    })
                  }
                />
              </div>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-x-handle">
                    X.com 投稿アカウント (@handle)
                  </label>
                  <input
                    id="input-x-handle"
                    type="text"
                    className="field-input"
                    placeholder="@your_handle"
                    value={settings.publish.xAccountHandle}
                    onChange={(e) =>
                      void handlePatchSettings({
                        publish: {
                          ...settings.publish,
                          xAccountHandle: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="input-x-hashtags">
                    X.com デフォルトハッシュタグ
                  </label>
                  <input
                    id="input-x-hashtags"
                    type="text"
                    className="field-input"
                    value={settings.publish.xHashtags}
                    onChange={(e) =>
                      void handlePatchSettings({
                        publish: {
                          ...settings.publish,
                          xHashtags: e.target.value,
                        },
                      })
                    }
                  />
                </div>
              </div>

              <div className="toggle-row">
                <div>
                  <div>X.com 投稿時にポッドキャスト動画 (MP4) を自動生成して添付</div>
                  <p className="field-hint">
                    OFF にするとテキスト要約＋参照リンクのみで素早く投稿画面を開きます
                  </p>
                </div>
                <input
                  id="toggle-x-attach-video"
                  type="checkbox"
                  checked={settings.publish.xAttachVideo}
                  onChange={(e) =>
                    void handlePatchSettings({
                      publish: {
                        ...settings.publish,
                        xAttachVideo: e.target.checked,
                      },
                    })
                  }
                />
              </div>
              <p className="field-hint">
                API 審査不要でログイン済みセッションをそのまま活かし、動画セット・タイトル・チャプター概要欄を半自動入力します（最終の「公開/ポスト」ボタンは必ずご自身で確認・押下する安全設計です）。
              </p>
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">パーソナリティ・番組構成</h2>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-host-a">
                    メイン進行 (HostA)
                  </label>
                  <input
                    id="input-host-a"
                    type="text"
                    className="field-input"
                    value={settings.hostAName}
                    onChange={(e) => void handlePatchSettings({ hostAName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="select-voice-a">
                    HostA ボイス
                  </label>
                  <select
                    id="select-voice-a"
                    className="field-select"
                    value={settings.hostAVoice}
                    onChange={(e) => void handlePatchSettings({ hostAVoice: e.target.value })}
                  >
                    {GEMINI_VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-row inline-two-col">
                <div>
                  <label className="field-label" htmlFor="input-host-b">
                    パートナー (HostB)
                  </label>
                  <input
                    id="input-host-b"
                    type="text"
                    className="field-input"
                    value={settings.hostBName}
                    onChange={(e) => void handlePatchSettings({ hostBName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="select-voice-b">
                    HostB ボイス
                  </label>
                  <select
                    id="select-voice-b"
                    className="field-select"
                    value={settings.hostBVoice}
                    onChange={(e) => void handlePatchSettings({ hostBVoice: e.target.value })}
                  >
                    {GEMINI_VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="select-duration">
                  番組の目標尺
                </label>
                <select
                  id="select-duration"
                  className="field-select"
                  value={settings.targetDurationMin}
                  onChange={(e) =>
                    void handlePatchSettings({
                      targetDurationMin: Number(e.target.value) as 5 | 10 | 15,
                    })
                  }
                >
                  <option value={5}>約 5 分（ヘッドライン速報）</option>
                  <option value={10}>約 10 分（標準バランス）</option>
                  <option value={15}>約 15 分（じっくり深掘り）</option>
                </select>
              </div>

              <div className="field-row">
                <label className="field-label" htmlFor="input-focus-topics">
                  重点ピックアップテーマ
                </label>
                <input
                  id="input-focus-topics"
                  type="text"
                  className="field-input"
                  value={settings.focusTopics}
                  onChange={(e) => void handlePatchSettings({ focusTopics: e.target.value })}
                />
              </div>
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">巡回・受動ストック対象サイト（標準）</h2>
              {PATROL_SOURCE_IDS.map((srcId) => (
                <div key={srcId} className="toggle-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="site-name-row">
                      <span>{SOURCE_META[srcId].label}</span>
                      <span className="method-badge">{SOURCE_META[srcId].extractionMethod}</span>
                    </div>
                    <p className="field-hint">{SOURCE_META[srcId].description}</p>
                    <details className="extract-details">
                      <summary>抽出の仕組みを見る</summary>
                      <p className="field-hint">
                        <strong>対象URL:</strong> {SOURCE_META[srcId].startUrl}
                        <br />
                        <strong>解析方法:</strong> {SOURCE_META[srcId].extractionDetail}
                      </p>
                    </details>
                  </div>
                  <input
                    id={`toggle-source-${srcId}`}
                    type="checkbox"
                    checked={Boolean(settings.enabledSources[srcId])}
                    onChange={(e) =>
                      void handlePatchSettings({
                        enabledSources: {
                          ...settings.enabledSources,
                          [srcId]: e.target.checked,
                        },
                      })
                    }
                  />
                </div>
              ))}

              <div className="toggle-row">
                <div>
                  <div>ブラウジング中の自動受動ストック</div>
                  <p className="field-hint">
                    普段X・記事・カスタムサイトをスクロールしている間に未読キューへ自動蓄積
                  </p>
                </div>
                <input
                  id="toggle-passive-capture"
                  type="checkbox"
                  checked={settings.passiveCaptureEnabled}
                  onChange={(e) =>
                    void handlePatchSettings({ passiveCaptureEnabled: e.target.checked })
                  }
                />
              </div>

              <div className="toggle-row">
                <div>
                  <div>毎日の定時自動編成 ({settings.autoScheduleTime})</div>
                  <p className="field-hint">指定時刻に自動で巡回・番組生成を実行</p>
                </div>
                <input
                  id="toggle-auto-schedule"
                  type="checkbox"
                  checked={settings.autoScheduleEnabled}
                  onChange={(e) =>
                    void handlePatchSettings({ autoScheduleEnabled: e.target.checked })
                  }
                />
              </div>
            </div>

            <div className="settings-group">
              <div className="section-toolbar" style={{ marginBottom: '8px' }}>
                <h2 className="settings-group-title" style={{ margin: 0 }}>
                  カスタム対象サイト ({(settings.customSites || []).length})
                </h2>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    id="btn-add-current-tab-site"
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '4px 8px', fontSize: '11.5px' }}
                    onClick={handlePrefillCustomSiteFromActiveTab}
                  >
                    ＋今のタブ
                  </button>
                  <button
                    id="btn-add-custom-site"
                    type="button"
                    className="btn-primary"
                    style={{ padding: '4px 9px', fontSize: '11.5px' }}
                    onClick={handleOpenAddCustomSite}
                  >
                    ＋新規追加
                  </button>
                </div>
              </div>

              {isSiteEditorOpen && (
                <div className="custom-site-editor">
                  <div className="field-row">
                    <label className="field-label" htmlFor="input-custom-site-name">
                      サイト名
                    </label>
                    <input
                      id="input-custom-site-name"
                      type="text"
                      className="field-input"
                      placeholder="例：Antigravity Changelog / Hacker News"
                      value={siteDraft.name}
                      onChange={(e) => setSiteDraft({ ...siteDraft, name: e.target.value })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label" htmlFor="input-custom-site-url">
                      巡回URL（RSSの場合はフィードURL）
                    </label>
                    <input
                      id="input-custom-site-url"
                      type="url"
                      className="field-input"
                      placeholder="https://antigravity.google/docs/changelog"
                      value={siteDraft.url}
                      onChange={(e) => setSiteDraft({ ...siteDraft, url: e.target.value })}
                    />
                  </div>
                  <div className="field-row">
                    <label className="field-label" htmlFor="select-custom-strategy">
                      テキスト抽出方式
                    </label>
                    <select
                      id="select-custom-strategy"
                      className="field-select"
                      value={siteDraft.extractionStrategy}
                      onChange={(e) =>
                        setSiteDraft({
                          ...siteDraft,
                          extractionStrategy: e.target.value as ExtractionStrategy,
                        })
                      }
                    >
                      {(Object.keys(EXTRACTION_STRATEGY_META) as ExtractionStrategy[]).map(
                        (key) => (
                          <option key={key} value={key}>
                            {EXTRACTION_STRATEGY_META[key].label}
                          </option>
                        )
                      )}
                    </select>
                    <p className="field-hint">
                      {EXTRACTION_STRATEGY_META[siteDraft.extractionStrategy].description}
                    </p>
                  </div>
                  {siteDraft.extractionStrategy === 'css_selector' && (
                    <div className="field-row">
                      <label className="field-label" htmlFor="input-custom-css">
                        抽出対象 CSS セレクタ
                      </label>
                      <input
                        id="input-custom-css"
                        type="text"
                        className="field-input"
                        placeholder="例: article, .post-item, .release-entry"
                        value={siteDraft.cssSelector || ''}
                        onChange={(e) =>
                          setSiteDraft({ ...siteDraft, cssSelector: e.target.value })
                        }
                      />
                    </div>
                  )}
                  <div className="field-row inline-two-col">
                    <div>
                      <label className="field-label" htmlFor="select-custom-scroll">
                        自動スクロール回数
                      </label>
                      <select
                        id="select-custom-scroll"
                        className="field-select"
                        value={siteDraft.scrollSteps}
                        onChange={(e) =>
                          setSiteDraft({ ...siteDraft, scrollSteps: Number(e.target.value) })
                        }
                      >
                        <option value={0}>0回（初期表示のみ）</option>
                        <option value={1}>1回</option>
                        <option value={2}>2回（SNS等）</option>
                        <option value={3}>3回（深め）</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '18px' }}>
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={siteDraft.enabled}
                          onChange={(e) =>
                            setSiteDraft({ ...siteDraft, enabled: e.target.checked })
                          }
                        />
                        <span>一括巡回に含める</span>
                      </label>
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={siteDraft.passiveEnabled}
                          onChange={(e) =>
                            setSiteDraft({ ...siteDraft, passiveEnabled: e.target.checked })
                          }
                        />
                        <span>閲覧時に受動ストック</span>
                      </label>
                    </div>
                  </div>
                  <div className="field-row">
                    <label className="field-label" htmlFor="input-custom-notes">
                      メモ（任意）
                    </label>
                    <input
                      id="input-custom-notes"
                      type="text"
                      className="field-input"
                      placeholder="例：毎週チェックするリリースノート"
                      value={siteDraft.notes || ''}
                      onChange={(e) => setSiteDraft({ ...siteDraft, notes: e.target.value })}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setIsSiteEditorOpen(false);
                        setEditingSiteId(null);
                      }}
                    >
                      キャンセル
                    </button>
                    <button
                      id="btn-save-custom-site"
                      type="button"
                      className="btn-primary"
                      onClick={handleSaveCustomSite}
                    >
                      {editingSiteId ? '変更を保存' : 'サイトを保存'}
                    </button>
                  </div>
                </div>
              )}

              {(settings.customSites || []).length === 0 ? (
                <p className="field-hint">
                  まだカスタムサイトがありません。「＋今のタブ」または「＋新規追加」から任意のニュース・ブログ・Changelog・RSSを追加できます。
                </p>
              ) : (
                <div className="custom-site-list">
                  {(settings.customSites || []).map((site) => (
                    <div key={site.id} className="custom-site-card">
                      <div className="custom-site-head">
                        <label className="inline-check" style={{ fontWeight: 600 }}>
                          <input
                            type="checkbox"
                            checked={site.enabled}
                            onChange={(e) =>
                              void handleToggleCustomSite(site.id, e.target.checked)
                            }
                          />
                          <span>{site.name}</span>
                        </label>
                        <span className="method-badge">
                          {EXTRACTION_STRATEGY_META[site.extractionStrategy]?.label ||
                            site.extractionStrategy}
                        </span>
                      </div>
                      <div className="custom-site-url" title={site.url}>
                        {site.url}
                      </div>
                      {site.cssSelector && (
                        <div className="field-hint">セレクタ: {site.cssSelector}</div>
                      )}
                      {site.notes && <div className="field-hint">{site.notes}</div>}
                      <div className="custom-site-actions">
                        <button
                          type="button"
                          className="share-btn"
                          disabled={isJobRunning}
                          onClick={() => void handlePatrolCustomSite(site.id, false)}
                        >
                          キュー取得
                        </button>
                        <button
                          type="button"
                          className="share-btn"
                          disabled={isJobRunning}
                          onClick={() => void handlePatrolCustomSite(site.id, true)}
                        >
                          すぐ番組化
                        </button>
                        <button
                          type="button"
                          className="share-btn"
                          onClick={() => handleEditCustomSite(site)}
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          className="share-btn"
                          onClick={() => void handleDeleteCustomSite(site.id)}
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <details className="pipeline-guide">
                <summary>情報収集・テキスト抽出の仕組み（4ステップ）</summary>
                <ol className="pipeline-steps">
                  <li>
                    <strong>セッション読み取り：</strong>
                    Chromeのログイン済みセッションを使い、オレンジ色の専用タブグループ「agentCast
                    巡回中」で対象URLを開きます（RSS方式はタブを開かず直接XML取得）。ログイン画面やCAPTCHAを検知すると即座に停止します。
                  </li>
                  <li>
                    <strong>DOM解析＆ノイズ除去：</strong>
                    サイト専用パーサー（Xの広告除外・Zennのコード要点化・Yahooの元記事追跡・Changelogのアクティブパネル抽出）、指定CSSセレクタ、または Mozilla
                    Readability でナビ・フッター・広告を除いた本文テキストを構造化します。
                  </li>
                  <li>
                    <strong>重複排除＆ローカル蓄積：</strong>
                    URL正規化とハッシュIDで重複を除外し、ブラウザ内の IndexedDB（未読キュー）へ保存します。外部サーバーへ収集データを送信することはありません。
                  </li>
                  <li>
                    <strong>AI番組構成＆音声化：</strong>
                    未読キューの本文を整理して2人掛け合いのJSON台本（固有タイトル・要約サブタイトル・チャプター別参照リンク付き）を生成し、TTSで音声化します。
                  </li>
                </ol>
              </details>
            </div>

            <div className="settings-group">
              <h2 className="settings-group-title">開発ビルド情報 (Cloud ⇄ Local Auto-Reload)</h2>
              <p className="field-hint">
                Build ID: {currentBuild?.buildId || 'dev'}
                <br />
                クラウド更新が同期されると待機中に自動で chrome.runtime.reload() されます。
              </p>
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <button
                  id="btn-force-reload"
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    chrome.runtime.sendMessage({
                      type: 'TRIGGER_DEV_RELOAD_NOW',
                    } satisfies RuntimeRequest)
                  }
                >
                  拡張機能を今すぐリロード
                </button>
                <button
                  id="btn-play-soundcheck"
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setTab('player');
                    void chrome.runtime.sendMessage({
                      type: 'CREATE_DEMO_EPISODE',
                    } satisfies RuntimeRequest);
                  }}
                >
                  テスト番組を生成
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
