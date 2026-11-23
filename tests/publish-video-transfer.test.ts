// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blobToArrayBuffer,
  MAX_PUBLISH_VIDEO_CHUNK_BYTES,
  readBlobChunkAsBase64,
} from '../src/shared/publish-utils';
import {
  injectXPublishHelper,
  injectYouTubePublishHelper,
} from '../src/providers/personal-only/publish-helpers';

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

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (window as Window & { __agentCastYtHelper__?: boolean }).__agentCastYtHelper__;
  delete (window as Window & { __agentCastXHelper__?: boolean }).__agentCastXHelper__;
});

describe('chunked publish video transfer', () => {
  it('reads a Blob in bounded base64 chunks and reconstructs identical bytes', async () => {
    const source = new Uint8Array(1000);
    for (let i = 0; i < source.length; i++) {
      source[i] = (i * 31) & 0xff;
    }
    const blob = new Blob([source], { type: 'video/mp4' });

    const chunks: Uint8Array[] = [];
    let offset = 0;
    let calls = 0;
    for (;;) {
      const res = await readBlobChunkAsBase64(blob, offset, 300);
      calls++;
      expect(res.offset).toBe(offset);
      expect(res.totalBytes).toBe(1000);
      const binary = atob(res.chunkBase64);
      const decoded = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        decoded[i] = binary.charCodeAt(i);
      }
      expect(decoded.byteLength).toBe(res.byteLength);
      chunks.push(decoded);
      offset += res.byteLength;
      if (res.done) break;
    }

    expect(calls).toBe(4);
    const merged = new Uint8Array(offset);
    let cursor = 0;
    for (const part of chunks) {
      merged.set(part, cursor);
      cursor += part.byteLength;
    }
    expect(Array.from(merged)).toEqual(Array.from(source));
  });

  it('caps requested chunk length to MAX_PUBLISH_VIDEO_CHUNK_BYTES', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/mp4' });
    const res = await readBlobChunkAsBase64(blob, 0, MAX_PUBLISH_VIDEO_CHUNK_BYTES * 10);
    expect(res.byteLength).toBe(4);
    expect(res.done).toBe(true);
  });

  it('reassembles chunked MP4 video in YouTube publish helper and attaches it to file input', async () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const blob = new Blob([payload], { type: 'video/mp4' });

    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'Filedata';
    let attachedFiles: File[] = [];
    Object.defineProperty(input, 'files', {
      configurable: true,
      set(val: FileList) {
        attachedFiles = Array.from(val);
      },
      get() {
        return attachedFiles as unknown as FileList;
      },
    });
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    document.body.appendChild(input);

    let chunkCalls = 0;
    const sendMessage = vi.fn((msg: { type: string; jobId?: string; offset?: number }, cb?: (res: unknown) => void) => {
      if (msg.type === 'GET_PENDING_PUBLISH_JOB') {
        cb?.({
          ok: true,
          job: {
            id: 'pub-yt-1',
            platform: 'youtube',
            title: 'Test Episode',
            description: 'Desc',
            visibility: 'unlisted',
            fileName: 'episode.mp4',
            mimeType: 'video/mp4',
            hasVideo: true,
            videoSizeBytes: payload.byteLength,
          },
        });
        return;
      }
      if (msg.type === 'GET_PENDING_PUBLISH_VIDEO_CHUNK') {
        chunkCalls++;
        // Serve in tiny 5-byte slices to verify multi-chunk reassembly
        void readBlobChunkAsBase64(blob, msg.offset ?? 0, 5).then((chunk) => {
          cb?.({ ok: true, ...chunk });
        });
      }
    });

    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    vi.stubGlobal('DataTransfer', MockDataTransfer);

    injectYouTubePublishHelper();

    const host = document.getElementById('agentcast-yt-publish-assistant');
    expect(host).not.toBeNull();
    const attachBtn = Array.from(host!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('MP4動画をアップロード枠へ自動セット')
    );
    expect(attachBtn).toBeDefined();

    attachBtn!.click();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    expect(chunkCalls).toBe(3); // 5 + 5 + 2 bytes
    expect(attachedFiles).toHaveLength(1);
    expect(attachedFiles[0].name).toBe('episode.mp4');
    expect(attachedFiles[0].type).toBe('video/mp4');
    expect(Array.from(new Uint8Array(await blobToArrayBuffer(attachedFiles[0])))).toEqual(Array.from(payload));

    // Second click should reuse cached File without requesting chunks again
    attachBtn!.click();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(2);
    });
    expect(chunkCalls).toBe(3);
  });

  it('reassembles chunked MP4 video in X publish helper and attaches it to file input', async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
    const blob = new Blob([payload], { type: 'video/mp4' });

    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-testid', 'fileInput');
    let attachedFiles: File[] = [];
    Object.defineProperty(input, 'files', {
      configurable: true,
      set(val: FileList) {
        attachedFiles = Array.from(val);
      },
      get() {
        return attachedFiles as unknown as FileList;
      },
    });
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    document.body.appendChild(input);

    const sendMessage = vi.fn((msg: { type: string; offset?: number }, cb?: (res: unknown) => void) => {
      if (msg.type === 'GET_PENDING_PUBLISH_JOB') {
        cb?.({
          ok: true,
          job: {
            id: 'pub-x-1',
            platform: 'x',
            title: 'Test X Episode',
            postText: 'hello',
            threadReplyText: 'links',
            fileName: 'x-episode.mp4',
            mimeType: 'video/mp4',
            hasVideo: true,
            videoSizeBytes: payload.byteLength,
          },
        });
        return;
      }
      if (msg.type === 'GET_PENDING_PUBLISH_VIDEO_CHUNK') {
        void readBlobChunkAsBase64(blob, msg.offset ?? 0, 3).then((chunk) => {
          cb?.({ ok: true, ...chunk });
        });
      }
    });

    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    vi.stubGlobal('DataTransfer', MockDataTransfer);

    injectXPublishHelper();

    const host = document.getElementById('agentcast-x-publish-assistant');
    expect(host).not.toBeNull();
    const attachBtn = Array.from(host!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('ポッドキャスト動画 (MP4) を添付')
    );
    expect(attachBtn).toBeDefined();

    attachBtn!.click();
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    expect(attachedFiles).toHaveLength(1);
    expect(attachedFiles[0].name).toBe('x-episode.mp4');
    expect(Array.from(new Uint8Array(await blobToArrayBuffer(attachedFiles[0])))).toEqual(Array.from(payload));
  });
});
