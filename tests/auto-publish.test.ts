// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildXPostPayload,
  readBlobChunkAsBase64,
  shouldAttachVideoToXPost,
} from '../src/shared/publish-utils';
import {
  injectXPublishHelper,
  injectYouTubePublishHelper,
} from '../src/providers/personal-only/publish-helpers';
import { DEFAULT_PUBLISH_SETTINGS, type PodcastEpisode } from '../src/shared/types';

class MockDataTransfer {
  private readonly list: File[] = [];
  items = {
    add: (file: File) => {
      this.list.push(file);
    },
  };
  get files(): FileList {
    return this.list as unknown as FileList;
  }
}

function makeEpisode(overrides: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return {
    id: 'ep-auto-1',
    title: 'NDLOCR-Lite ver.2公開＆EUのEV優遇日本除外・80年代BRAUNデザイン論',
    subtitle: '国立国会図書館の軽量OCR刷新、EUのEV優遇修正案、資産経理基準30年ぶり改定、第2次補正予算とBRAUNデザイン哲学を解説',
    createdAt: '2026-11-24T13:39:00.000Z',
    status: 'ready',
    providerLabel: 'Gemini',
    ttsEngineLabel: 'Gemini TTS',
    totalDurationSec: 600,
    sourceCount: 5,
    chapters: [
      {
        id: 'ch-1',
        index: 0,
        title: 'NDLOCR-Lite ver.2 公開の衝撃',
        summary: '軽量OCRが大幅刷新',
        sourceItems: [
          {
            id: 's1',
            source: 'zenn',
            title: 'NDLOCR-Lite ver.2',
            url: 'https://example.com/ndlocr',
          },
        ],
        turns: [],
        durationSec: 180,
        hasAudioBlob: true,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (window as Window & { __agentCastYtHelper__?: boolean }).__agentCastYtHelper__;
  delete (window as Window & { __agentCastXHelper__?: boolean }).__agentCastXHelper__;
});

describe('auto-publish payload & helpers', () => {
  it('embeds YouTube URL into X post text without truncating the URL', () => {
    const ep = makeEpisode();
    const ytUrl = 'https://youtu.be/dQw4w9WgXcQ';
    const payload = buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xIncludeYouTubeUrl: true }, {
      youtubeUrl: ytUrl,
    });

    expect(payload.postText).toContain(`📺 ${ytUrl}`);
    expect(payload.postText.endsWith(ytUrl)).toBe(true);
    expect(payload.threadReplyText).toContain(ytUrl);
  });

  it('omits YouTube URL from X post text when xIncludeYouTubeUrl is false', () => {
    const ep = makeEpisode({ publishedYouTubeUrl: 'https://youtu.be/dQw4w9WgXcQ' });
    const payload = buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xIncludeYouTubeUrl: false });

    expect(payload.postText).not.toContain('youtu.be');
  });

  it('defaults xPostMediaMode to link_only and supports all 4 unified X media modes', () => {
    expect(DEFAULT_PUBLISH_SETTINGS.xPostMediaMode).toBe('link_only');
    expect(DEFAULT_PUBLISH_SETTINGS.ytToXMediaMode).toBe('link_only');
    expect(DEFAULT_PUBLISH_SETTINGS.xAttachVideo).toBe(false);

    const ep = makeEpisode({ publishedYouTubeUrl: 'https://youtu.be/dQw4w9WgXcQ' });

    // 1. link_only (default): includes YouTube URL, no MP4 attached
    expect(
      shouldAttachVideoToXPost(DEFAULT_PUBLISH_SETTINGS, { isYtToXAutoLink: true, hasVideo: true })
    ).toBe(false);
    expect(
      buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'link_only' }).postText
    ).toContain('youtu.be');

    // 2. link_and_video: includes YouTube URL AND attaches MP4
    expect(
      shouldAttachVideoToXPost(
        { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'link_and_video' },
        { isYtToXAutoLink: true, hasVideo: true }
      )
    ).toBe(true);
    expect(
      buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'link_and_video' })
        .postText
    ).toContain('youtu.be');

    // 3. video_only: omits YouTube URL, attaches MP4
    expect(
      shouldAttachVideoToXPost(
        { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'video_only' },
        { isYtToXAutoLink: true, hasVideo: true }
      )
    ).toBe(true);
    expect(
      buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'video_only' }).postText
    ).not.toContain('youtu.be');

    // 4. text_only: omits YouTube URL, no MP4 attached
    expect(
      shouldAttachVideoToXPost(
        { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'text_only' },
        { isYtToXAutoLink: false, hasVideo: true }
      )
    ).toBe(false);
    expect(
      buildXPostPayload(ep, { ...DEFAULT_PUBLISH_SETTINGS, xPostMediaMode: 'text_only' }).postText
    ).not.toContain('youtu.be');

    // Legacy fallback without xPostMediaMode
    expect(
      shouldAttachVideoToXPost(
        { ytToXMediaMode: 'link_only', xAttachVideo: true },
        { isYtToXAutoLink: true, hasVideo: true }
      )
    ).toBe(false);
    expect(
      shouldAttachVideoToXPost(
        { ytToXMediaMode: 'link_only', xAttachVideo: true },
        { isYtToXAutoLink: false, hasVideo: true }
      )
    ).toBe(true);
  });

  it('runs YouTube Studio full-auto flow and reports extracted video URL', async () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const blob = new Blob([payload], { type: 'video/mp4' });

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.name = 'Filedata';
    let attachedFiles: File[] = [];
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      set(val: FileList) {
        attachedFiles = Array.from(val);
      },
      get() {
        return attachedFiles as unknown as FileList;
      },
    });
    document.body.appendChild(fileInput);

    // When file is attached, render Details form + video link + Next/Done buttons
    const notForKidsClicked = vi.fn();
    const unlistedClicked = vi.fn();
    const doneClicked = vi.fn();
    let titleBox!: HTMLDivElement;
    let descBox!: HTMLDivElement;

    fileInput.addEventListener('change', () => {
      titleBox = document.createElement('div');
      titleBox.id = 'textbox';
      titleBox.setAttribute('contenteditable', 'true');
      descBox = document.createElement('div');
      descBox.id = 'textbox';
      descBox.setAttribute('contenteditable', 'true');

      const notForKids = document.createElement('tp-yt-paper-radio-button');
      notForKids.setAttribute('name', 'VIDEO_MADE_FOR_KIDS_NOT_MFK');
      notForKids.addEventListener('click', notForKidsClicked);

      const videoLink = document.createElement('a');
      videoLink.href = 'https://youtu.be/dQw4w9WgXcQ';
      videoLink.textContent = 'https://youtu.be/dQw4w9WgXcQ';

      const nextBtn = document.createElement('button');
      nextBtn.id = 'next-button';
      nextBtn.addEventListener('click', () => {
        const unlisted = document.createElement('tp-yt-paper-radio-button');
        unlisted.setAttribute('name', 'UNLISTED');
        unlisted.addEventListener('click', unlistedClicked);

        const doneBtn = document.createElement('button');
        doneBtn.id = 'done-button';
        doneBtn.addEventListener('click', () => {
          doneClicked();
          doneBtn.remove();
        });

        document.body.appendChild(unlisted);
        document.body.appendChild(doneBtn);
      });

      document.body.appendChild(titleBox);
      document.body.appendChild(descBox);
      document.body.appendChild(notForKids);
      document.body.appendChild(videoLink);
      document.body.appendChild(nextBtn);
    });

    const reports: Array<{ status: string; publishedUrl?: string }> = [];
    const sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (res: unknown) => void) => {
      if (msg.type === 'GET_PENDING_PUBLISH_JOB') {
        cb?.({
          ok: true,
          job: {
            id: 'pub-yt-auto',
            mediaJobId: 'pub-media-1',
            platform: 'youtube',
            title: 'Auto Episode Title',
            description: '00:00 Opening',
            visibility: 'unlisted',
            autoSubmit: true,
            fileName: 'auto.mp4',
            mimeType: 'video/mp4',
            hasVideo: true,
            videoSizeBytes: payload.byteLength,
          },
        });
        return;
      }
      if (msg.type === 'GET_PENDING_PUBLISH_VIDEO_CHUNK') {
        void readBlobChunkAsBase64(blob, (msg.offset as number) ?? 0, 1024).then((chunk) => {
          cb?.({ ok: true, ...chunk });
        });
        return;
      }
      if (msg.type === 'REPORT_PUBLISH_RESULT') {
        reports.push({
          status: msg.status as string,
          publishedUrl: msg.publishedUrl as string | undefined,
        });
        cb?.({ ok: true });
      }
    });

    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    vi.stubGlobal('DataTransfer', MockDataTransfer);

    injectYouTubePublishHelper();

    await vi.waitFor(
      () => {
        expect(reports.some((r) => r.status === 'completed')).toBe(true);
      },
      { timeout: 5000 }
    );

    expect(attachedFiles).toHaveLength(1);
    expect(titleBox.textContent).toBe('Auto Episode Title');
    expect(descBox.textContent).toBe('00:00 Opening');
    expect(notForKidsClicked).toHaveBeenCalledTimes(1);
    expect(unlistedClicked).toHaveBeenCalledTimes(1);
    expect(doneClicked).toHaveBeenCalledTimes(1);
    const completed = reports.find((r) => r.status === 'completed');
    expect(completed?.publishedUrl).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('runs X.com full-auto flow, attaches video, clicks Post, and reports status URL', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([payload], { type: 'video/mp4' });

    const switcher = document.createElement('div');
    switcher.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
    switcher.textContent = 'Kamihicouki @kamihicouki';
    document.body.appendChild(switcher);

    const textarea = document.createElement('div');
    textarea.setAttribute('data-testid', 'tweetTextarea_0');
    textarea.textContent = '🎙 Auto Post https://youtu.be/dQw4w9WgXcQ';
    document.body.appendChild(textarea);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.setAttribute('data-testid', 'fileInput');
    let attachedFiles: File[] = [];
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      set(val: FileList) {
        attachedFiles = Array.from(val);
      },
      get() {
        return attachedFiles as unknown as FileList;
      },
    });
    document.body.appendChild(fileInput);

    const postBtn = document.createElement('button');
    postBtn.setAttribute('data-testid', 'tweetButton');
    const postClicked = vi.fn(() => {
      textarea.remove();
      const toast = document.createElement('div');
      toast.setAttribute('data-testid', 'toast');
      const link = document.createElement('a');
      link.href = 'https://x.com/kamihicouki/status/1234567890';
      toast.appendChild(link);
      document.body.appendChild(toast);
    });
    postBtn.addEventListener('click', postClicked);
    document.body.appendChild(postBtn);

    const reports: Array<{ status: string; publishedUrl?: string }> = [];
    const sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (res: unknown) => void) => {
      if (msg.type === 'GET_PENDING_PUBLISH_JOB') {
        cb?.({
          ok: true,
          job: {
            id: 'pub-x-auto',
            mediaJobId: 'pub-media-1',
            platform: 'x',
            title: 'Auto Episode Title',
            postText: '🎙 Auto Post https://youtu.be/dQw4w9WgXcQ',
            threadReplyText: 'links',
            expectedXHandle: '@kamihicouki',
            autoSubmit: true,
            fileName: 'auto.mp4',
            mimeType: 'video/mp4',
            hasVideo: true,
            videoSizeBytes: payload.byteLength,
          },
        });
        return;
      }
      if (msg.type === 'GET_PENDING_PUBLISH_VIDEO_CHUNK') {
        void readBlobChunkAsBase64(blob, (msg.offset as number) ?? 0, 1024).then((chunk) => {
          cb?.({ ok: true, ...chunk });
        });
        return;
      }
      if (msg.type === 'REPORT_PUBLISH_RESULT') {
        reports.push({
          status: msg.status as string,
          publishedUrl: msg.publishedUrl as string | undefined,
        });
        cb?.({ ok: true });
      }
    });

    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    vi.stubGlobal('DataTransfer', MockDataTransfer);

    injectXPublishHelper();

    await vi.waitFor(
      () => {
        expect(reports.some((r) => r.status === 'completed')).toBe(true);
      },
      { timeout: 5000 }
    );

    expect(attachedFiles).toHaveLength(1);
    expect(postClicked).toHaveBeenCalledTimes(1);
    const completed = reports.find((r) => r.status === 'completed');
    expect(completed?.publishedUrl).toBe('https://x.com/kamihicouki/status/1234567890');
  });

  it('aborts X.com full-auto post safely when logged-in account mismatches expectedXHandle', async () => {
    const switcher = document.createElement('div');
    switcher.setAttribute('data-testid', 'SideNav_AccountSwitcher_Button');
    switcher.textContent = 'OtherUser @wrong_account';
    document.body.appendChild(switcher);

    const postBtn = document.createElement('button');
    postBtn.setAttribute('data-testid', 'tweetButton');
    const postClicked = vi.fn();
    postBtn.addEventListener('click', postClicked);
    document.body.appendChild(postBtn);

    const reports: Array<{ status: string; message?: string }> = [];
    const sendMessage = vi.fn((msg: Record<string, unknown>, cb?: (res: unknown) => void) => {
      if (msg.type === 'GET_PENDING_PUBLISH_JOB') {
        cb?.({
          ok: true,
          job: {
            id: 'pub-x-mismatch',
            platform: 'x',
            title: 'Mismatch Test',
            postText: 'hello',
            threadReplyText: '',
            expectedXHandle: '@kamihicouki',
            autoSubmit: true,
            hasVideo: false,
          },
        });
        return;
      }
      if (msg.type === 'REPORT_PUBLISH_RESULT') {
        reports.push({
          status: msg.status as string,
          message: msg.message as string | undefined,
        });
        cb?.({ ok: true });
      }
    });

    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });

    injectXPublishHelper();

    await vi.waitFor(() => {
      expect(reports.some((r) => r.status === 'failed')).toBe(true);
    });

    expect(postClicked).not.toHaveBeenCalled();
    expect(reports[0].message).toContain('アカウント不一致');
  });
});
