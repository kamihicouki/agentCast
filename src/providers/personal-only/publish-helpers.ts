/**
 * Publishing automation assistants injected into YouTube Studio and X.com.
 * Both scripts are completely self-contained so chrome.scripting.executeScript can serialize them.
 * When `job.autoSubmit === true`, they run the full end-to-end flow automatically with an on-screen
 * cancel button; otherwise they stay in manual step-by-step assistant mode.
 */

export function injectYouTubePublishHelper(): void {
  const win = window as Window & { __agentCastYtHelper__?: boolean };
  if (win.__agentCastYtHelper__) return;
  win.__agentCastYtHelper__ = true;

  type PublishJob = {
    id: string;
    episodeId?: string;
    mediaJobId?: string;
    platform: 'youtube' | 'x';
    title: string;
    description: string;
    visibility?: 'unlisted' | 'private' | 'public';
    channelName?: string;
    autoSubmit?: boolean;
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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  function isElementVisible(el: Element | null | undefined): el is HTMLElement {
    if (!el || !(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return true;
  }

  function isButtonDisabled(el: Element): boolean {
    if (el instanceof HTMLButtonElement && el.disabled) return true;
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return true;
    if (el.hasAttribute('disabled')) return true;
    const innerBtn = el.shadowRoot?.querySelector('button') || el.querySelector('button');
    if (innerBtn) {
      if (innerBtn.disabled || innerBtn.getAttribute('aria-disabled') === 'true') return true;
    }
    return false;
  }

  function clickDeepButton(el: HTMLElement): void {
    const innerBtn =
      (el.shadowRoot?.querySelector('button') as HTMLElement | null) ||
      (el.querySelector('button') as HTMLElement | null);
    if (innerBtn) {
      innerBtn.click();
    } else {
      el.click();
    }
  }

  function normalizeYouTubeUrl(raw: string): string | null {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    const shortMatch = /https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})/i.exec(trimmed);
    if (shortMatch?.[1]) return `https://youtu.be/${shortMatch[1]}`;
    const watchMatch = /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^#\s]*v=([A-Za-z0-9_-]{11})/i.exec(
      trimmed
    );
    if (watchMatch?.[1]) return `https://youtu.be/${watchMatch[1]}`;
    const studioMatch = /https?:\/\/studio\.youtube\.com\/video\/([A-Za-z0-9_-]{11})/i.exec(trimmed);
    if (studioMatch?.[1]) return `https://youtu.be/${studioMatch[1]}`;
    return null;
  }

  function extractYouTubeVideoUrl(): string | null {
    const anchors = queryAllDeep(
      document,
      'a[href*="youtu.be/"], a[href*="youtube.com/watch"], a.ytcp-video-info[href]'
    ) as HTMLAnchorElement[];
    for (const a of anchors) {
      const normalized = normalizeYouTubeUrl(a.href || a.getAttribute('href') || a.textContent || '');
      if (normalized) return normalized;
    }
    const urlNodes = queryAllDeep(document, '.video-url-fadeable, ytcp-video-info');
    for (const node of urlNodes) {
      const normalized = normalizeYouTubeUrl(node.textContent || '');
      if (normalized) return normalized;
    }
    return normalizeYouTubeUrl(window.location.href);
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
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || (el.textContent || '').trim() !== text.trim()) {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  chrome.runtime.sendMessage({ type: 'GET_PENDING_PUBLISH_JOB' }, (res) => {
    const job = res?.job as PublishJob | null;
    if (!job || job.platform !== 'youtube') return;

    const hasVideo = Boolean(job.hasVideo || job.videoBase64);
    const mediaJobId = job.mediaJobId || job.id;
    let cachedVideoFile: File | null = null;
    let loadingVideoPromise: Promise<File> | null = null;
    let autoCancelled = false;

    function reportResult(
      status: 'progress' | 'completed' | 'failed' | 'cancelled',
      message: string,
      publishedUrl?: string
    ): void {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'REPORT_PUBLISH_RESULT',
            jobId: job!.id,
            platform: 'youtube',
            status,
            message,
            publishedUrl,
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      } catch {
        // ignore messaging errors on unload
      }
    }

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
          const chunk = await requestVideoChunk(mediaJobId, offset, CHUNK_BYTES);
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
    header.innerHTML = job.autoSubmit
      ? '<span>📺 agentCast YouTube 自動公開</span>'
      : '<span>📺 agentCast YouTube 公開ガイド</span>';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
    closeBtn.onclick = () => {
      autoCancelled = true;
      host.remove();
    };
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
    }公開設定: ${visLabel} / 「${job.title.slice(0, 32)}」`;

    const statusEl = document.createElement('div');
    statusEl.style.cssText =
      'font-size:12px;color:#e5a44d;margin-bottom:10px;padding:7px 9px;background:#22252c;border-radius:8px;word-break:break-word;';
    statusEl.textContent = job.autoSubmit
      ? '🤖 自動公開を開始しています...（いつでも下のボタンで中止できます）'
      : hasVideo
      ? '①「MP4を自動セット」→ アップロード画面が開いたら ②「タイトル・概要欄を入力」を押してください。'
      : '音声ファイル未生成のエピソードです。先に音声付きで番組を作成するか、概要欄をコピーしてご利用ください。';

    const btnCol = document.createElement('div');
    btnCol.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

    const cancelAutoBtn = document.createElement('button');
    cancelAutoBtn.textContent = '⏹ 自動公開を中止して手動切替';
    cancelAutoBtn.style.cssText =
      'background:#5c2424;color:#ffd9d6;border:1px solid rgba(239,133,125,0.45);border-radius:8px;padding:8px 12px;font-weight:700;font-size:12px;cursor:pointer;';
    if (!job.autoSubmit) cancelAutoBtn.style.display = 'none';
    cancelAutoBtn.onclick = () => {
      autoCancelled = true;
      cancelAutoBtn.style.display = 'none';
      statusEl.style.color = '#e5a44d';
      statusEl.textContent = '自動公開を中止しました。下のボタンから手動で操作できます。';
      reportResult('cancelled', 'ユーザーが YouTube 自動公開を中止しました。');
    };

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

    async function attachVideoFileToInput(targetInput: HTMLInputElement): Promise<void> {
      statusEl.style.color = '#e5a44d';
      statusEl.textContent = 'MP4動画データを読み込み中...';
      const file = await loadVideoFile((pct) => {
        statusEl.textContent = `MP4動画データを読み込み中... (${pct}%)`;
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      targetInput.files = dt.files;
      targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function findUploadFileInput(): HTMLInputElement | null {
      const inputs = queryAllDeep(document, 'input[type="file"]') as HTMLInputElement[];
      return inputs.find((inp) => (inp.name || '').toLowerCase().includes('file')) || inputs[0] || null;
    }

    function fillMetadataFields(): { filled: number; videoUrl: string | null } {
      const textboxes = queryAllDeep(document, '#textbox[contenteditable="true"]') as HTMLElement[];
      let filled = 0;

      if (textboxes[0]) {
        setEditableText(textboxes[0], job!.title);
        filled++;
      }
      if (textboxes[1]) {
        setEditableText(textboxes[1], job!.description);
        filled++;
      }

      // Select "No, it's not made for kids" so YouTube Studio allows advancing to Visibility
      const notForKidsRadios = queryAllDeep(
        document,
        'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'
      ) as HTMLElement[];
      if (notForKidsRadios[0]) {
        notForKidsRadios[0].click();
      }

      if (job!.visibility) {
        const radioName = job!.visibility.toUpperCase();
        const radios = queryAllDeep(
          document,
          `tp-yt-paper-radio-button[name="${radioName}"]`
        ) as HTMLElement[];
        if (radios[0] && isElementVisible(radios[0])) {
          radios[0].click();
        }
      }

      return { filled, videoUrl: extractYouTubeVideoUrl() };
    }

    attachBtn.onclick = async () => {
      if (!hasVideo) return;
      const targetInput = findUploadFileInput();

      if (!targetInput) {
        statusEl.textContent =
          'アップロード枠が見つかりません。YouTube Studio 右上の「作成 → 動画をアップロード」を開いてからもう一度押してください。';
        return;
      }

      attachBtn.disabled = true;
      downloadBtn.disabled = true;
      try {
        await attachVideoFileToInput(targetInput);
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
      const { filled } = fillMetadataFields();

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
    btnCol.appendChild(cancelAutoBtn);
    btnCol.appendChild(attachBtn);
    btnCol.appendChild(fillMetaBtn);
    btnCol.appendChild(subRow);

    host.appendChild(header);
    host.appendChild(metaEl);
    host.appendChild(statusEl);
    host.appendChild(btnCol);
    document.body.appendChild(host);

    async function runFullAutoPublish(): Promise<void> {
      if (!hasVideo) {
        const msg = 'MP4動画データがないため YouTube 自動公開を実行できません。';
        statusEl.style.color = '#ef857d';
        statusEl.textContent = msg;
        cancelAutoBtn.style.display = 'none';
        reportResult('failed', msg);
        return;
      }

      const setProgress = (msg: string) => {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = msg;
        reportResult('progress', msg);
      };

      try {
        // Step 1: Wait for upload file input (clicking Create -> Upload if modal isn't open yet)
        setProgress('1/5 アップロード画面の読み込みを待機中...');
        let targetInput = findUploadFileInput();
        let triedCreateClick = false;
        const inputDeadline = Date.now() + 25_000;
        while (!targetInput && Date.now() < inputDeadline) {
          if (autoCancelled) return;
          if (!triedCreateClick && Date.now() > inputDeadline - 20_000) {
            const createBtns = queryAllDeep(
              document,
              '#create-icon, ytcp-button#create-icon, [aria-label="作成"], [aria-label="Create"]'
            ) as HTMLElement[];
            if (createBtns[0]) {
              triedCreateClick = true;
              clickDeepButton(createBtns[0]);
              await sleep(600);
              const menuItems = queryAllDeep(
                document,
                '#text-item-0, tp-yt-paper-item, ytcp-text-menu tp-yt-paper-item'
              ) as HTMLElement[];
              const uploadItem =
                menuItems.find((item) =>
                  /アップロード|upload/i.test(item.textContent || '')
                ) || menuItems[0];
              if (uploadItem) {
                uploadItem.click();
              }
            }
          }
          await sleep(450);
          targetInput = findUploadFileInput();
        }
        if (autoCancelled) return;
        if (!targetInput) {
          throw new Error('YouTube Studio のアップロード枠が見つかりませんでした（ログイン状態をご確認ください）。');
        }

        setProgress('2/5 MP4動画をアップロード枠へ自動セット中...');
        await attachVideoFileToInput(targetInput);
        if (autoCancelled) return;

        // Step 2: Wait for Details textboxes and fill title, description, not-for-kids
        setProgress('3/5 タイトル・概要欄・子ども向け設定を自動入力中...');
        let textboxes: HTMLElement[] = [];
        const formDeadline = Date.now() + 35_000;
        while (textboxes.length < 2 && Date.now() < formDeadline) {
          if (autoCancelled) return;
          textboxes = queryAllDeep(document, '#textbox[contenteditable="true"]') as HTMLElement[];
          if (textboxes.length >= 2) break;
          await sleep(450);
        }
        if (autoCancelled) return;
        if (textboxes.length === 0) {
          throw new Error('YouTube Studio の詳細入力フォームが表示されませんでした。');
        }

        const { videoUrl: initialUrl } = fillMetadataFields();
        let detectedVideoUrl = initialUrl;
        await sleep(500);
        if (autoCancelled) return;

        // Step 3: Advance wizard steps ("Next") until Visibility radio is visible
        setProgress('4/5 公開設定ステップへ移動中...');
        const visName = (job!.visibility || 'unlisted').toUpperCase();
        const findVisRadio = () => {
          const radios = queryAllDeep(
            document,
            `tp-yt-paper-radio-button[name="${visName}"]`
          ) as HTMLElement[];
          return radios.find((r) => isElementVisible(r)) || null;
        };

        let visRadio = findVisRadio();
        for (let step = 0; step < 5 && !visRadio; step++) {
          if (autoCancelled) return;
          if (!detectedVideoUrl) detectedVideoUrl = extractYouTubeVideoUrl();
          const nextBtns = queryAllDeep(
            document,
            '#next-button, ytcp-button#next-button'
          ) as HTMLElement[];
          const nextBtn = nextBtns.find((b) => isElementVisible(b) && !isButtonDisabled(b));
          if (nextBtn) {
            clickDeepButton(nextBtn);
            await sleep(750);
          } else {
            await sleep(500);
          }
          visRadio = findVisRadio();
        }
        if (autoCancelled) return;

        if (visRadio) {
          visRadio.click();
          await sleep(400);
        }
        if (!detectedVideoUrl) detectedVideoUrl = extractYouTubeVideoUrl();

        // Step 4: Wait for Done/Publish button to become enabled, then click it
        setProgress('5/5 動画のアップロード完了・公開ボタン有効化を待機中...');
        const doneDeadline = Date.now() + 5 * 60 * 1000;
        let doneBtn: HTMLElement | null = null;
        while (Date.now() < doneDeadline) {
          if (autoCancelled) return;
          if (!detectedVideoUrl) detectedVideoUrl = extractYouTubeVideoUrl();
          const candidates = queryAllDeep(
            document,
            '#done-button, ytcp-button#done-button'
          ) as HTMLElement[];
          const ready = candidates.find((b) => isElementVisible(b) && !isButtonDisabled(b));
          if (ready) {
            doneBtn = ready;
            break;
          }
          const progressLabel = queryAllDeep(document, '.progress-label')[0]?.textContent?.trim();
          if (progressLabel) {
            statusEl.textContent = `5/5 アップロード待機中: ${progressLabel.slice(0, 60)}`;
          }
          await sleep(800);
        }
        if (autoCancelled) return;
        if (!doneBtn) {
          throw new Error('YouTube の「保存/公開」ボタンが有効になりませんでした。手動で確認して押してください。');
        }

        clickDeepButton(doneBtn);
        setProgress('YouTube 公開確定を処理中...');

        // Wait briefly for confirmation dialog & final video URL
        const confirmDeadline = Date.now() + 20_000;
        while (Date.now() < confirmDeadline) {
          if (autoCancelled) return;
          const urlNow = extractYouTubeVideoUrl();
          if (urlNow) detectedVideoUrl = urlNow;
          const shareDialog = queryAllDeep(
            document,
            'ytcp-video-share-dialog, #dialog-title'
          ).find((el) => isElementVisible(el));
          const doneStillThere = queryAllDeep(
            document,
            '#done-button, ytcp-button#done-button'
          ).some((el) => isElementVisible(el));
          if (shareDialog || !doneStillThere) {
            break;
          }
          await sleep(500);
        }

        cancelAutoBtn.style.display = 'none';
        statusEl.style.color = '#65c493';
        statusEl.textContent = detectedVideoUrl
          ? `✅ YouTube 公開完了！ (${detectedVideoUrl})`
          : '✅ YouTube 公開処理を実行しました！';
        reportResult(
          'completed',
          detectedVideoUrl
            ? `YouTube 公開完了: ${detectedVideoUrl}`
            : 'YouTube 公開処理を実行しました。',
          detectedVideoUrl || undefined
        );
      } catch (err) {
        if (autoCancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        cancelAutoBtn.style.display = 'none';
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `⚠️ 自動公開でエラー: ${msg}`;
        reportResult('failed', msg);
      }
    }

    if (job.autoSubmit) {
      void runFullAutoPublish();
    }
  });
}

export function injectXPublishHelper(): void {
  const win = window as Window & { __agentCastXHelper__?: boolean };
  if (win.__agentCastXHelper__) return;
  win.__agentCastXHelper__ = true;

  type PublishJob = {
    id: string;
    episodeId?: string;
    mediaJobId?: string;
    platform: 'youtube' | 'x';
    title: string;
    postText: string;
    threadReplyText: string;
    expectedXHandle?: string;
    youtubeUrl?: string;
    autoSubmit?: boolean;
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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function detectLoggedInHandle(): string {
    const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const match = /@([A-Za-z0-9_]{1,20})/.exec(switcher?.textContent || '');
    return match ? `@${match[1]}` : '';
  }

  function setEditableText(el: HTMLElement, text: string): void {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isButtonEnabled(btn: Element | null): btn is HTMLElement {
    if (!btn || !(btn instanceof HTMLElement)) return false;
    if (btn instanceof HTMLButtonElement && btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.hasAttribute('disabled')) return false;
    return true;
  }

  function findPostButton(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('[data-testid="tweetButton"]') ||
      document.querySelector<HTMLElement>('[data-testid="tweetButtonInline"]')
    );
  }

  chrome.runtime.sendMessage({ type: 'GET_PENDING_PUBLISH_JOB' }, (res) => {
    const job = res?.job as PublishJob | null;
    if (!job || job.platform !== 'x') return;

    const hasVideo = Boolean(job.hasVideo || job.videoBase64);
    const mediaJobId = job.mediaJobId || job.id;
    let cachedVideoFile: File | null = null;
    let loadingVideoPromise: Promise<File> | null = null;
    let autoCancelled = false;

    function reportResult(
      status: 'progress' | 'completed' | 'failed' | 'cancelled',
      message: string,
      publishedUrl?: string
    ): void {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'REPORT_PUBLISH_RESULT',
            jobId: job!.id,
            platform: 'x',
            status,
            message,
            publishedUrl,
          },
          () => {
            void chrome.runtime.lastError;
          }
        );
      } catch {
        // ignore messaging errors on unload
      }
    }

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
          const chunk = await requestVideoChunk(mediaJobId, offset, CHUNK_BYTES);
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
    header.innerHTML = job.autoSubmit
      ? '<span>𝕏 agentCast 自動投稿</span>'
      : '<span>𝕏 agentCast 投稿ガイド</span>';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#9b958b;cursor:pointer;font-size:14px;';
    closeBtn.onclick = () => {
      autoCancelled = true;
      host.remove();
    };
    header.appendChild(closeBtn);

    const accountEl = document.createElement('div');
    accountEl.style.cssText = 'font-size:12px;color:#c4bdb1;margin-bottom:8px;';
    const activeHandle = detectLoggedInHandle();
    const expected = (job.expectedXHandle || '').trim();
    let accountMismatch = false;
    if (expected) {
      const normalizedExpected = expected.startsWith('@') ? expected : `@${expected}`;
      if (activeHandle && activeHandle.toLowerCase() !== normalizedExpected.toLowerCase()) {
        accountMismatch = true;
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
      'font-size:12px;color:#c4bdb1;margin-bottom:10px;padding:7px 9px;background:#22252c;border-radius:8px;word-break:break-word;';
    statusEl.textContent = job.autoSubmit
      ? '🤖 X.com への自動投稿を開始しています...'
      : hasVideo
      ? '本文を自動セット済みです。下のボタンでポッドキャスト動画を添付し、確認後に「ポストする」を押してください。'
      : '本文を自動セット済みです。内容を確認して「ポストする」を押してください。';

    const btnCol = document.createElement('div');
    btnCol.style.cssText = 'display:flex;flex-direction:column;gap:7px;';

    const cancelAutoBtn = document.createElement('button');
    cancelAutoBtn.textContent = '⏹ 自動投稿を中止して手動切替';
    cancelAutoBtn.style.cssText =
      'background:#5c2424;color:#ffd9d6;border:1px solid rgba(239,133,125,0.45);border-radius:8px;padding:8px 12px;font-weight:700;font-size:12px;cursor:pointer;';
    if (!job.autoSubmit) cancelAutoBtn.style.display = 'none';
    cancelAutoBtn.onclick = () => {
      autoCancelled = true;
      cancelAutoBtn.style.display = 'none';
      statusEl.style.color = '#e5a44d';
      statusEl.textContent = '自動投稿を中止しました。下のボタンから手動で投稿できます。';
      reportResult('cancelled', 'ユーザーが X 自動投稿を中止しました。');
    };

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

    async function attachVideoToInput(input: HTMLInputElement): Promise<void> {
      statusEl.style.color = '#e5a44d';
      statusEl.textContent = 'MP4動画データを読み込み中...';
      const file = await loadVideoFile((pct) => {
        statusEl.textContent = `MP4動画データを読み込み中... (${pct}%)`;
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

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
        await attachVideoToInput(input);
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

    btnCol.appendChild(cancelAutoBtn);
    btnCol.appendChild(attachBtn);
    btnCol.appendChild(copyReplyBtn);
    btnCol.appendChild(downloadBtn);

    host.appendChild(header);
    if (accountEl.textContent) host.appendChild(accountEl);
    host.appendChild(statusEl);
    host.appendChild(btnCol);
    document.body.appendChild(host);

    async function runFullAutoPost(): Promise<void> {
      if (accountMismatch) {
        const msg = `X アカウント不一致のため自動投稿を停止しました（現在: ${activeHandle} / 設定先: ${expected}）。`;
        cancelAutoBtn.style.display = 'none';
        statusEl.style.color = '#ef857d';
        statusEl.textContent = msg;
        reportResult('failed', msg);
        return;
      }

      const setProgress = (msg: string) => {
        statusEl.style.color = '#e5a44d';
        statusEl.textContent = msg;
        reportResult('progress', msg);
      };

      try {
        // Step 1: Wait for composer textarea
        setProgress('1/4 X 投稿フォームの読み込みを待機中...');
        let textarea: HTMLElement | null = null;
        const formDeadline = Date.now() + 25_000;
        while (!textarea && Date.now() < formDeadline) {
          if (autoCancelled) return;
          textarea = document.querySelector<HTMLElement>('[data-testid="tweetTextarea_0"]');
          if (textarea) break;
          await sleep(400);
        }
        if (autoCancelled) return;
        if (!textarea) {
          throw new Error('X の投稿フォームが見つかりませんでした（ログイン状態をご確認ください）。');
        }

        if (!(textarea.textContent || '').trim() && job!.postText) {
          setEditableText(textarea, job!.postText);
          await sleep(300);
        }

        // Step 2: Attach MP4 video if requested and wait for upload completion
        if (hasVideo) {
          setProgress('2/4 ポッドキャスト動画 (MP4) を自動添付中...');
          let fileInput: HTMLInputElement | null = null;
          const inputDeadline = Date.now() + 15_000;
          while (!fileInput && Date.now() < inputDeadline) {
            if (autoCancelled) return;
            fileInput = document.querySelector<HTMLInputElement>(
              'input[data-testid="fileInput"], input[type="file"][accept*="video"]'
            );
            if (fileInput) break;
            await sleep(400);
          }
          if (autoCancelled) return;
          if (!fileInput) {
            throw new Error('X の動画添付欄が見つかりませんでした。');
          }

          await attachVideoToInput(fileInput);
          if (autoCancelled) return;

          setProgress('3/4 X への動画アップロード完了を待機中...');
          await sleep(1000);

          const uploadDeadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < uploadDeadline) {
            if (autoCancelled) return;
            const postBtn = findPostButton();
            const uploadingBar = document.querySelector('[role="progressbar"]');
            const hasUploadingText = /アップロード中|uploading|processing|処理中/i.test(
              document.querySelector('[data-testid="attachments"]')?.textContent || ''
            );
            if (isButtonEnabled(postBtn) && !uploadingBar && !hasUploadingText) {
              break;
            }
            await sleep(800);
          }
        }

        if (autoCancelled) return;

        // Step 3: Click final Post button
        setProgress('4/4 ポストボタンを自動クリック中...');
        let postBtn: HTMLElement | null = null;
        const btnDeadline = Date.now() + 15_000;
        while (Date.now() < btnDeadline) {
          if (autoCancelled) return;
          const candidate = findPostButton();
          if (isButtonEnabled(candidate)) {
            postBtn = candidate;
            break;
          }
          await sleep(400);
        }
        if (autoCancelled) return;
        if (!postBtn) {
          throw new Error('「ポストする」ボタンが有効になりませんでした。文字数や動画サイズをご確認ください。');
        }

        postBtn.click();

        // Step 4: Wait for post submission confirmation & capture status URL if shown in toast
        let postedUrl: string | undefined;
        const confirmDeadline = Date.now() + 20_000;
        while (Date.now() < confirmDeadline) {
          if (autoCancelled) return;
          const toastLink = document.querySelector<HTMLAnchorElement>(
            '[data-testid="toast"] a[href*="/status/"]'
          );
          if (toastLink?.href) {
            postedUrl = toastLink.href;
            break;
          }
          const composerGone = !document.querySelector('[data-testid="tweetTextarea_0"]');
          if (composerGone) {
            break;
          }
          await sleep(400);
        }

        cancelAutoBtn.style.display = 'none';
        statusEl.style.color = '#65c493';
        statusEl.textContent = postedUrl
          ? `✅ X.com への投稿を完了しました！ (${postedUrl})`
          : '✅ X.com への投稿を完了しました！';
        reportResult(
          'completed',
          postedUrl ? `X.com 投稿完了: ${postedUrl}` : 'X.com への投稿を完了しました。',
          postedUrl
        );
      } catch (err) {
        if (autoCancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        cancelAutoBtn.style.display = 'none';
        statusEl.style.color = '#ef857d';
        statusEl.textContent = `⚠️ 自動投稿でエラー: ${msg}`;
        reportResult('failed', msg);
      }
    }

    if (job.autoSubmit) {
      void runFullAutoPost();
    }
  });
}
