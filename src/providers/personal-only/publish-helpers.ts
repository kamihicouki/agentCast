/**
 * Human-in-the-loop semi-automated publishing assistants injected into YouTube Studio and X.com.
 * Both scripts are completely self-contained so chrome.scripting.executeScript can serialize them.
 * Neither script ever clicks the final "Publish" or "Post" button — the user always reviews and confirms.
 */

export function injectYouTubePublishHelper(): void {
  const win = window as Window & { __agentCastYtHelper__?: boolean };
  if (win.__agentCastYtHelper__) return;
  win.__agentCastYtHelper__ = true;

  type PublishJob = {
    id: string;
    platform: 'youtube' | 'x';
    title: string;
    description: string;
    visibility?: 'unlisted' | 'private' | 'public';
    channelName?: string;
    fileName?: string;
    mimeType?: string;
    hasVideo?: boolean;
    videoSizeBytes?: number;
    videoBase64?: string;
  };

  type VideoChunkResponse = {
    ok?: boolean;
    error?: string;
    chunkBase64?: string;
    offset?: number;
    byteLength?: number;
    totalBytes?: number;
    done?: boolean;
  };

  const CHUNK_BYTES = 4 * 1024 * 1024;

  function queryAllDeep(root: Document | ShadowRoot | Element, selector: string): Element[] {
    const found: Element[] = Array.from(root.querySelectorAll(selector));
    const elements = root.querySelectorAll('*');
    for (const el of elements) {
      if (el.shadowRoot) {
        found.push(...queryAllDeep(el.shadowRoot, selector));
      }
    }
    return found;
  }

  function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function requestVideoChunk(
    jobId: string,
    offset: number,
    length: number
  ): Promise<VideoChunkResponse> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'GET_PENDING_PUBLISH_VIDEO_CHUNK', jobId, offset, length },
        (res) => {
          const runtimeErr = chrome.runtime.lastError;
          if (runtimeErr) {
            reject(new Error(runtimeErr.message || '動画データの取得に失敗しました。'));
            return;
          }
          resolve((res || {}) as VideoChunkResponse);
        }
      );
    });
  }

  function setEditableText(el: HTMLElement, text: string): void {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  chrome.runtime.sendMessage({ type: 'GET_PENDING_PUBLISH_JOB' }, (res) => {
    const job = res?.job as PublishJob | null;
    if (!job || job.platform !== 'youtube') return;

    const hasVideo = Boolean(job.hasVideo || job.videoBase64);
    let cachedVideoFile: File | null = null;
    let loadingVideoPromise: Promise<File> | null = null;

    async function loadVideoFile(onProgress?: (pct: number) => void): Promise<File> {
      if (cachedVideoFile) return cachedVideoFile;
      if (loadingVideoPromise) return loadingVideoPromise;

      const fileName = job!.fileName || 'agentcast.mp4';
      const mimeType = job!.mimeType || 'video/mp4';

      if (job!.videoBase64) {
        cachedVideoFile = new File([base64ToBytes(job!.videoBase64)], fileName, { type: mimeType });
        return cachedVideoFile;
      }

      loadingVideoPromise = (async () => {
        const parts: BlobPart[] = [];
        let offset = 0;
        for (;;) {
          const chunk = await requestVideoChunk(job!.id, offset, CHUNK_BYTES);
          if (!chunk?.ok) {
            throw new Error(chunk?.error || '動画チャンクの読み込みに失敗しました。');
          }
          const bytes = chunk.chunkBase64 ? base64ToBytes(chunk.chunkBase64) : new Uint8Array(0);
          if (bytes.byteLength > 0) {
            parts.push(bytes);
          }
          offset += chunk.byteLength ?? bytes.byteLength;
          const totalBytes = chunk.totalBytes ?? job!.videoSizeBytes ?? offset;
          if (totalBytes > 0) {
            onProgress?.(Math.min(100, Math.round((offset / totalBytes) * 100)));
          }
          if (chunk.done) break;
          if ((chunk.byteLength ?? bytes.byteLength) <= 0) {
            throw new Error('動画チャンクの転送が途中で終了しました。');
          }
        }
        const file = new File(parts, fileName, { type: mimeType });
        cachedVideoFile = file;
        return file;
      })().finally(() => {
        loadingVideoPromise = null;
      });

      return loadingVideoPromise;
    }

    const host = document.createElement('div');
    host.id = 'agentcast-yt-publish-assistant';
    host.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'width:360px',
      'background:#181a1f',
      'color:#f4efe6',
      'border:1px solid rgba(229,107,67,0.6)',
      'border-radius:14px',
      'padding:14px 16px',
      'box-shadow:0 16px 40px rgba(0,0,0,0.52)',
      'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif',
      'font-size:13px',
      'line-height:1.5',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;margin-bottom:6px;';
    header.innerHTML = '<span>📺 agentCast YouTube 公開ガイド</span>';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
    closeBtn.onclick = () => host.remove();
    header.appendChild(closeBtn);

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:12px;color:#c4bdb1;margin-bottom:10px;';
    const visLabel =
      job.visibility === 'public'
        ? '公開'
        : job.visibility === 'private'
        ? '非公開'
        : '限定公開';
    metaEl.textContent = `${
      job.channelName ? `対象: ${job.channelName} · ` : ''
    }公開設定案: ${visLabel} / 「${job.title.slice(0, 32)}」`;

    const statusEl = document.createElement('div');
    statusEl.style.cssText =
      'font-size:12px;color:#e5a44d;margin-bottom:10px;padding:7px 9px;background:#22252c;border-radius:8px;';
    statusEl.textContent = hasVideo
      ? '①「MP4を自動セット」→ アップロード画面が開いたら ②「タイトル・概要欄を入力」を押してください。'
      : '音声ファイル未生成のエピソードです。先に音声付きで番組を作成するか、概要欄をコピーしてご利用ください。';

    const btnCol = document.createElement('div');
    btnCol.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

    const attachBtn = document.createElement('button');
    attachBtn.textContent = '① MP4動画をアップロード枠へ自動セット';
    attachBtn.style.cssText =
      'background:#e56b43;color:#fff;border:none;border-radius:8px;padding:9px 12px;font-weight:700;font-size:12.5px;cursor:pointer;';
    if (!hasVideo) attachBtn.style.display = 'none';

    const fillMetaBtn = document.createElement('button');
    fillMetaBtn.textContent = '② タイトル・概要欄・公開範囲を自動入力';
    fillMetaBtn.style.cssText =
      'background:#2a2e36;color:#f4efe6;border:1px solid rgba(244,239,230,0.2);border-radius:8px;padding:8px 12px;font-weight:600;font-size:12.5px;cursor:pointer;';

    const subRow = document.createElement('div');
    subRow.style.cssText = 'display:flex;gap:6px;';

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'MP4保存';
    downloadBtn.style.cssText =
      'flex:1;background:#22252c;color:#c4bdb1;border:1px solid rgba(244,239,230,0.14);border-radius:7px;padding:6px 8px;font-size:11.5px;cursor:pointer;';
    if (!hasVideo) downloadBtn.style.display = 'none';

    const copyDescBtn = document.createElement('button');
    copyDescBtn.textContent = '概要欄コピー';
    copyDescBtn.style.cssText =
      'flex:1;background:#22252c;color:#c4bdb1;border:1px solid rgba(244,239,230,0.14);border-radius:7px;padding:6px 8px;font-size:11.5px;cursor:pointer;';

    attachBtn.onclick = async () => {
      if (!hasVideo) return;
      const inputs = queryAllDeep(document, 'input[type="file"]') as HTMLInputElement[];
      const targetInput =
        inputs.find((inp) => (inp.name || '').toLowerCase().includes('file')) || inputs[0];

      if (!targetInput) {
        statusEl.textContent =
          'アップロード枠が見つかりません。YouTube Studio 右上の「作成 → 動画をアップロード」を開いてからもう一度押してください。';
        return;
      }

      attachBtn.disabled = true;
      downloadBtn.disabled = true;
      try {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = 'MP4動画データを読み込み中...';
        const file = await loadVideoFile((pct) => {
          statusEl.textContent = `MP4動画データを読み込み中... (${pct}%)`;
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        targetInput.files = dt.files;
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
        statusEl.style.color = '#65c493';
        statusEl.textContent =
          '✅ MP4動画をセットしました！詳細フォームが表示されたら「② タイトル・概要欄を自動入力」を押してください。';
      } catch (err) {
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `自動セットに失敗しました。「MP4保存」から手動ドロップしてください (${String(err)})`;
      } finally {
        attachBtn.disabled = false;
        downloadBtn.disabled = false;
      }
    };

    fillMetaBtn.onclick = () => {
      const textboxes = queryAllDeep(document, '#textbox[contenteditable="true"]') as HTMLElement[];
      let filled = 0;

      if (textboxes[0]) {
        setEditableText(textboxes[0], job.title);
        filled++;
      }
      if (textboxes[1]) {
        setEditableText(textboxes[1], job.description);
        filled++;
      }

      // Try selecting visibility radio if currently on Visibility step
      if (job.visibility) {
        const radioName = job.visibility.toUpperCase();
        const radios = queryAllDeep(
          document,
          `tp-yt-paper-radio-button[name="${radioName}"]`
        ) as HTMLElement[];
        if (radios[0]) {
          radios[0].click();
        }
      }

      if (filled > 0) {
        statusEl.style.color = '#65c493';
        statusEl.textContent =
          '✅ タイトルとチャプター付き概要欄を入力しました！内容と公開範囲を確認してYouTube側の「保存/公開」を押してください。';
      } else {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent =
          '入力欄がまだ表示されていません。動画アップロード後の詳細画面で押すか、「概要欄コピー」をご利用ください。';
      }
    };

    downloadBtn.onclick = async () => {
      if (!hasVideo) return;
      attachBtn.disabled = true;
      downloadBtn.disabled = true;
      try {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = 'MP4動画データを準備中...';
        const file = await loadVideoFile((pct) => {
          statusEl.textContent = `MP4動画データを準備中... (${pct}%)`;
        });
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        statusEl.style.color = '#65c493';
        statusEl.textContent = '✅ MP4動画のダウンロードを開始しました。';
      } catch (err) {
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `MP4保存に失敗しました (${String(err)})`;
      } finally {
        attachBtn.disabled = false;
        downloadBtn.disabled = false;
      }
    };

    copyDescBtn.onclick = () => {
      void navigator.clipboard.writeText(`${job.title}\n\n${job.description}`).then(() => {
        statusEl.style.color = '#65c493';
        statusEl.textContent = '✅ タイトル＆概要欄をクリップボードにコピーしました。';
      });
    };

    subRow.appendChild(downloadBtn);
    subRow.appendChild(copyDescBtn);
    btnCol.appendChild(attachBtn);
    btnCol.appendChild(fillMetaBtn);
    btnCol.appendChild(subRow);

    host.appendChild(header);
    host.appendChild(metaEl);
    host.appendChild(statusEl);
    host.appendChild(btnCol);
    document.body.appendChild(host);
  });
}

export function injectXPublishHelper(): void {
  const win = window as Window & { __agentCastXHelper__?: boolean };
  if (win.__agentCastXHelper__) return;
  win.__agentCastXHelper__ = true;

  type PublishJob = {
    id: string;
    platform: 'youtube' | 'x';
    title: string;
    postText: string;
    threadReplyText: string;
    expectedXHandle?: string;
    fileName?: string;
    mimeType?: string;
    hasVideo?: boolean;
    videoSizeBytes?: number;
    videoBase64?: string;
  };

  type VideoChunkResponse = {
    ok?: boolean;
    error?: string;
    chunkBase64?: string;
    offset?: number;
    byteLength?: number;
    totalBytes?: number;
    done?: boolean;
  };

  const CHUNK_BYTES = 4 * 1024 * 1024;

  function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function requestVideoChunk(
    jobId: string,
    offset: number,
    length: number
  ): Promise<VideoChunkResponse> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'GET_PENDING_PUBLISH_VIDEO_CHUNK', jobId, offset, length },
        (res) => {
          const runtimeErr = chrome.runtime.lastError;
          if (runtimeErr) {
            reject(new Error(runtimeErr.message || '動画データの取得に失敗しました。'));
            return;
          }
          resolve((res || {}) as VideoChunkResponse);
        }
      );
    });
  }

  function detectLoggedInHandle(): string {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const match = /@([A-Za-z0-9_]{1,20})/.exec(switcher?.textContent || '');
    return match ? `@${match[1]}` : '';
  }

  chrome.runtime.sendMessage({ type: 'GET_PENDING_PUBLISH_JOB' }, (res) => {
    const job = res?.job as PublishJob | null;
    if (!job || job.platform !== 'x') return;

    const hasVideo = Boolean(job.hasVideo || job.videoBase64);
    let cachedVideoFile: File | null = null;
    let loadingVideoPromise: Promise<File> | null = null;

    async function loadVideoFile(onProgress?: (pct: number) => void): Promise<File> {
      if (cachedVideoFile) return cachedVideoFile;
      if (loadingVideoPromise) return loadingVideoPromise;

      const fileName = job!.fileName || 'agentcast.mp4';
      const mimeType = job!.mimeType || 'video/mp4';

      if (job!.videoBase64) {
        cachedVideoFile = new File([base64ToBytes(job!.videoBase64)], fileName, { type: mimeType });
        return cachedVideoFile;
      }

      loadingVideoPromise = (async () => {
        const parts: BlobPart[] = [];
        let offset = 0;
        for (;;) {
          const chunk = await requestVideoChunk(job!.id, offset, CHUNK_BYTES);
          if (!chunk?.ok) {
            throw new Error(chunk?.error || '動画チャンクの読み込みに失敗しました。');
          }
          const bytes = chunk.chunkBase64 ? base64ToBytes(chunk.chunkBase64) : new Uint8Array(0);
          if (bytes.byteLength > 0) {
            parts.push(bytes);
          }
          offset += chunk.byteLength ?? bytes.byteLength;
          const totalBytes = chunk.totalBytes ?? job!.videoSizeBytes ?? offset;
          if (totalBytes > 0) {
            onProgress?.(Math.min(100, Math.round((offset / totalBytes) * 100)));
          }
          if (chunk.done) break;
          if ((chunk.byteLength ?? bytes.byteLength) <= 0) {
            throw new Error('動画チャンクの転送が途中で終了しました。');
          }
        }
        const file = new File(parts, fileName, { type: mimeType });
        cachedVideoFile = file;
        return file;
      })().finally(() => {
        loadingVideoPromise = null;
      });

      return loadingVideoPromise;
    }

    const host = document.createElement('div');
    host.id = 'agentcast-x-publish-assistant';
    host.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483647',
      'width:350px',
      'background:#181a1f',
      'color:#f4efe6',
      'border:1px solid rgba(229,107,67,0.6)',
      'border-radius:14px',
      'padding:14px 16px',
      'box-shadow:0 16px 40px rgba(0,0,0,0.52)',
      'font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif',
      'font-size:13px',
      'line-height:1.5',
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;margin-bottom:6px;';
    header.innerHTML = '<span>𝕏 agentCast 投稿ガイド</span>';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
    closeBtn.onclick = () => host.remove();
    header.appendChild(closeBtn);

    const accountEl = document.createElement('div');
    accountEl.style.cssText = 'font-size:12px;color:#c4bdb1;margin-bottom:8px;';
    const activeHandle = detectLoggedInHandle();
    const expected = (job.expectedXHandle || '').trim();
    if (expected) {
      const normalizedExpected = expected.startsWith('@') ? expected : `@${expected}`;
      if (activeHandle && activeHandle.toLowerCase() !== normalizedExpected.toLowerCase()) {
        accountEl.style.color = '#ef857d';
        accountEl.textContent = `⚠️ 現在 ${activeHandle} でログイン中（設定先: ${normalizedExpected}）。アカウント切替をご確認ください。`;
      } else {
        accountEl.style.color = '#65c493';
        accountEl.textContent = `投稿アカウント確認: ${activeHandle || normalizedExpected}`;
      }
    } else if (activeHandle) {
      accountEl.textContent = `ログイン中アカウント: ${activeHandle}`;
    }

    const statusEl = document.createElement('div');
    statusEl.style.cssText =
      'font-size:12px;color:#c4bdb1;margin-bottom:10px;padding:7px 9px;background:#22252c;border-radius:8px;';
    statusEl.textContent = hasVideo
      ? '本文を自動セット済みです。下のボタンでポッドキャスト動画を添付し、確認後に「ポストする」を押してください。'
      : '本文を自動セット済みです。内容を確認して「ポストする」を押してください。';

    const btnCol = document.createElement('div');
    btnCol.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

    const attachBtn = document.createElement('button');
    attachBtn.textContent = '🎬 ポッドキャスト動画 (MP4) を添付';
    attachBtn.style.cssText =
      'background:#e56b43;color:#fff;border:none;border-radius:8px;padding:9px 12px;font-weight:700;font-size:12.5px;cursor:pointer;';
    if (!hasVideo) attachBtn.style.display = 'none';

    const copyReplyBtn = document.createElement('button');
    copyReplyBtn.textContent = '📋 参照リンク（リプライ用）をコピー';
    copyReplyBtn.style.cssText =
      'background:#2a2e36;color:#f4efe6;border:1px solid rgba(244,239,230,0.2);border-radius:8px;padding:8px 12px;font-weight:600;font-size:12px;cursor:pointer;';

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'MP4をローカル保存（手動添付用）';
    downloadBtn.style.cssText =
      'background:#22252c;color:#c4bdb1;border:1px solid rgba(244,239,230,0.14);border-radius:7px;padding:6px 8px;font-size:11.5px;cursor:pointer;';
    if (!hasVideo) downloadBtn.style.display = 'none';

    attachBtn.onclick = async () => {
      if (!hasVideo) return;
      const input = document.querySelector<HTMLInputElement>(
        'input[data-testid="fileInput"], input[type="file"][accept*="video"]'
      );
      if (!input) {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent =
          '投稿画面のメディア添付欄が見つかりませんでした。下の「MP4をローカル保存」からドラッグ＆ドロップしてください。';
        return;
      }

      attachBtn.disabled = true;
      downloadBtn.disabled = true;
      try {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = 'MP4動画データを読み込み中...';
        const file = await loadVideoFile((pct) => {
          statusEl.textContent = `MP4動画データを読み込み中... (${pct}%)`;
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        statusEl.style.color = '#65c493';
        statusEl.textContent =
          '✅ 動画を添付しました！プレビューを確認して「ポストする」を押してください。';
      } catch (err) {
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `動画添付に失敗しました: ${String(err)}`;
      } finally {
        attachBtn.disabled = false;
        downloadBtn.disabled = false;
      }
    };

    copyReplyBtn.onclick = () => {
      void navigator.clipboard.writeText(job.threadReplyText).then(() => {
        statusEl.style.color = '#65c493';
        statusEl.textContent = '✅ リプライ用の参照リンク一覧をコピーしました。';
      });
    };

    downloadBtn.onclick = async () => {
      if (!hasVideo) return;
      attachBtn.disabled = true;
      downloadBtn.disabled = true;
      try {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = 'MP4動画データを準備中...';
        const file = await loadVideoFile((pct) => {
          statusEl.textContent = `MP4動画データを準備中... (${pct}%)`;
        });
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        statusEl.style.color = '#65c493';
        statusEl.textContent = '✅ MP4動画のダウンロードを開始しました。';
      } catch (err) {
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `MP4保存に失敗しました (${String(err)})`;
      } finally {
        attachBtn.disabled = false;
        downloadBtn.disabled = false;
      }
    };

    btnCol.appendChild(attachBtn);
    btnCol.appendChild(copyReplyBtn);
    btnCol.appendChild(downloadBtn);

    host.appendChild(header);
    if (accountEl.textContent) host.appendChild(accountEl);
    host.appendChild(statusEl);
    host.appendChild(btnCol);
    document.body.appendChild(host);
  });
}
