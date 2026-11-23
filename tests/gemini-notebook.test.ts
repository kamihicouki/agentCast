// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractGeminiChatIdFromUrl,
  isAgentCastScriptText,
  runDomOrganizeCurrentGeminiChatToNotebook,
  runDomOrganizePastGeminiScriptsToNotebook,
} from '../src/providers/personal-only/web-llm-bridge';

interface MockChat {
  id: string;
  title: string;
  prompt: string;
  response: string;
  inNotebooks: Set<string>;
}

function buildMockGeminiDom(opts: {
  initialNotebooks: string[];
  createMode: 'dialog' | 'untitled_sidebar';
  chats: MockChat[];
  activeChatId?: string;
}) {
  document.body.innerHTML = '';

  const notebooks: Array<{ id: string; name: string }> = opts.initialNotebooks.map((name, i) => ({
    id: `nb-${i + 1}`,
    name,
  }));

  const sidebar = document.createElement('bard-sidenav');
  const main = document.createElement('main');
  const overlayHost = document.createElement('div');
  overlayHost.className = 'cdk-overlay-container';
  document.body.append(sidebar, main, overlayHost);

  const clearOverlay = () => {
    overlayHost.innerHTML = '';
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') clearOverlay();
  });

  const renderMainChat = (chat: MockChat | undefined) => {
    main.innerHTML = '';
    if (!chat) return;
    const uq = document.createElement('user-query');
    uq.textContent = chat.prompt;
    const mr = document.createElement('model-response');
    mr.textContent = chat.response;
    main.append(uq, mr);
  };

  const openNotebookPicker = (chat: MockChat) => {
    clearOverlay();
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    pane.setAttribute('role', 'dialog');

    for (const nb of notebooks) {
      const item = document.createElement('button');
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', chat.inNotebooks.has(nb.name) ? 'true' : 'false');
      item.textContent = nb.name;
      item.addEventListener('click', () => {
        chat.inNotebooks.add(nb.name);
        item.setAttribute('aria-checked', 'true');
        clearOverlay();
      });
      pane.appendChild(item);
    }
    overlayHost.appendChild(pane);
  };

  const openChatMenu = (chat: MockChat) => {
    clearOverlay();
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');

    const shareBtn = document.createElement('button');
    shareBtn.setAttribute('role', 'menuitem');
    shareBtn.textContent = '会話を共有';

    const addBtn = document.createElement('button');
    addBtn.setAttribute('role', 'menuitem');
    addBtn.textContent = 'ノートブックに追加';
    addBtn.addEventListener('click', () => openNotebookPicker(chat));

    menu.append(shareBtn, addBtn);
    pane.appendChild(menu);
    overlayHost.appendChild(pane);
  };

  const openRenameDialog = (nb: { id: string; name: string }) => {
    clearOverlay();
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    pane.setAttribute('role', 'dialog');

    const input = document.createElement('input');
    input.type = 'text';
    input.value = nb.name;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => {
      nb.name = input.value.trim() || nb.name;
      clearOverlay();
      renderSidebar();
    });

    pane.append(input, saveBtn);
    overlayHost.appendChild(pane);
  };

  const openNotebookMenu = (nb: { id: string; name: string }) => {
    clearOverlay();
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');

    const renameBtn = document.createElement('button');
    renameBtn.setAttribute('role', 'menuitem');
    renameBtn.textContent = '名前を変更';
    renameBtn.addEventListener('click', () => openRenameDialog(nb));

    menu.appendChild(renameBtn);
    pane.appendChild(menu);
    overlayHost.appendChild(pane);
  };

  const renderSidebar = () => {
    sidebar.innerHTML = '';

    const nbHeading = document.createElement('h3');
    nbHeading.textContent = 'ノートブック';
    sidebar.appendChild(nbHeading);

    const createBtn = document.createElement('button');
    createBtn.innerHTML = '<mat-icon>add</mat-icon><span>ノートブックを新規作成</span>';
    createBtn.addEventListener('click', () => {
      if (opts.createMode === 'dialog') {
        clearOverlay();
        const pane = document.createElement('div');
        pane.className = 'cdk-overlay-pane';
        pane.setAttribute('role', 'dialog');
        const input = document.createElement('input');
        input.type = 'text';
        const okBtn = document.createElement('button');
        okBtn.textContent = '作成';
        okBtn.addEventListener('click', () => {
          notebooks.push({ id: `nb-${notebooks.length + 1}`, name: input.value.trim() });
          clearOverlay();
          renderSidebar();
        });
        pane.append(input, okBtn);
        overlayHost.appendChild(pane);
      } else {
        notebooks.push({ id: `nb-${notebooks.length + 1}`, name: 'Untitled notebook' });
        renderSidebar();
      }
    });
    sidebar.appendChild(createBtn);

    for (const nb of notebooks) {
      const wrap = document.createElement('div');
      const link = document.createElement('a');
      link.href = `/notebook/${nb.id}`;
      link.innerHTML = `<mat-icon>book</mat-icon><span>${nb.name}</span>`;
      const moreBtn = document.createElement('button');
      moreBtn.setAttribute('aria-label', 'オプション');
      moreBtn.innerHTML = '<mat-icon>more_vert</mat-icon>';
      moreBtn.addEventListener('click', () => openNotebookMenu(nb));
      wrap.append(link, moreBtn);
      sidebar.appendChild(wrap);
    }

    const allHeading = document.createElement('h3');
    allHeading.textContent = 'すべて';
    sidebar.appendChild(allHeading);

    for (const chat of opts.chats) {
      const wrap = document.createElement('div');
      const link = document.createElement('a');
      link.href = `/app/${chat.id}`;
      link.setAttribute('data-test-id', 'conversation');
      if (opts.activeChatId === chat.id) {
        link.setAttribute('aria-current', 'page');
      }
      link.textContent = chat.title;
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        renderMainChat(chat);
      });

      const moreBtn = document.createElement('button');
      moreBtn.setAttribute('aria-label', 'その他のオプション');
      moreBtn.innerHTML = '<mat-icon>more_vert</mat-icon>';
      moreBtn.addEventListener('click', () => openChatMenu(chat));

      wrap.append(link, moreBtn);
      sidebar.appendChild(wrap);
    }
  };

  renderSidebar();
  if (opts.activeChatId) {
    renderMainChat(opts.chats.find((c) => c.id === opts.activeChatId));
  }

  return { notebooks };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Gemini agentcast notebook helpers', () => {
  it('detects agentCast podcast script prompts and JSON responses accurately', () => {
    expect(
      isAgentCastScriptText(
        'あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。\n現在日時: 2026/11/23 21:29'
      )
    ).toBe(true);
    expect(
      isAgentCastScriptText(
        '{"title":"テスト","chapters":[{"title":"導入","sourceIds":["x-1"],"turns":[{"speaker":"HostA","text":"こんにちは"}]}]}'
      )
    ).toBe(true);
    expect(isAgentCastScriptText('Search ConsoleデータとBigQuery連携について教えてください')).toBe(
      false
    );
    expect(isAgentCastScriptText('{"status":"ok","items":[1,2,3]}')).toBe(false);
  });

  it('extracts Gemini chat IDs from /app/<id> URLs', () => {
    expect(extractGeminiChatIdFromUrl('https://gemini.google.com/app/64761157c23d4079')).toBe(
      '64761157c23d4079'
    );
    expect(extractGeminiChatIdFromUrl('https://gemini.google.com/app')).toBe('');
    expect(extractGeminiChatIdFromUrl(undefined)).toBe('');
  });

  it('adds current chat to an existing agentcast notebook without creating a duplicate', async () => {
    const chat: MockChat = {
      id: 'chat-new-1',
      title: 'テックと社会のトレンド解説',
      prompt: 'あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。',
      response: '{"title":"test","chapters":[{"turns":[{"speaker":"HostA"}]}]}',
      inNotebooks: new Set(),
    };
    const { notebooks } = buildMockGeminiDom({
      initialNotebooks: ['ガジェット買取検証', 'agentcast'],
      createMode: 'dialog',
      chats: [chat],
      activeChatId: chat.id,
    });

    const res = await runDomOrganizeCurrentGeminiChatToNotebook('agentcast', chat.id);
    expect(res).toMatchObject({
      ok: true,
      notebookName: 'agentcast',
      createdNotebook: false,
      status: 'added',
      chatId: 'chat-new-1',
    });
    expect(notebooks.map((n) => n.name)).toEqual(['ガジェット買取検証', 'agentcast']);
    expect(chat.inNotebooks.has('agentcast')).toBe(true);
  });

  it('creates agentcast notebook via dialog when missing and adds current chat', async () => {
    const chat: MockChat = {
      id: 'chat-new-2',
      title: 'AIトレンド解説',
      prompt: 'あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。',
      response: '{}',
      inNotebooks: new Set(),
    };
    const { notebooks } = buildMockGeminiDom({
      initialNotebooks: ['Untitled notebook'],
      createMode: 'dialog',
      chats: [chat],
      activeChatId: chat.id,
    });

    const res = await runDomOrganizeCurrentGeminiChatToNotebook('agentcast', chat.id);
    expect(res).toMatchObject({
      ok: true,
      createdNotebook: true,
      status: 'added',
    });
    expect(notebooks.some((n) => n.name === 'agentcast')).toBe(true);
    expect(chat.inNotebooks.has('agentcast')).toBe(true);
  });

  it('creates and renames newly added Untitled notebook in sidebar when dialog is not used', async () => {
    const chat: MockChat = {
      id: 'chat-new-3',
      title: '連休最終日の注目トピック',
      prompt: 'あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。',
      response: '{}',
      inNotebooks: new Set(),
    };
    const { notebooks } = buildMockGeminiDom({
      initialNotebooks: ['Untitled notebook'],
      createMode: 'untitled_sidebar',
      chats: [chat],
      activeChatId: chat.id,
    });

    const res = await runDomOrganizeCurrentGeminiChatToNotebook('agentcast', chat.id);
    expect(res).toMatchObject({
      ok: true,
      createdNotebook: true,
      status: 'added',
    });
    // Existing user's Untitled notebook should stay intact, newly created one renamed to agentcast
    expect(notebooks.map((n) => n.name)).toEqual(['Untitled notebook', 'agentcast']);
    expect(chat.inNotebooks.has('agentcast')).toBe(true);
  });

  it('organizes all past agentCast scripts into agentcast notebook while skipping non-script chats', async () => {
    const chats: MockChat[] = [
      {
        id: 'c1',
        title: 'テックと社会のトレンド解説',
        prompt: 'あなたは日本の人気テクノロジー＆ニュース解説ポッドキャスト番組の構成作家です。',
        response: '{"title":"7兆円ゼロトラスト","chapters":[{"turns":[{"speaker":"HostA"}]}]}',
        inNotebooks: new Set(),
      },
      {
        id: 'c2',
        title: 'Search ConsoleデータとBigQuery連携',
        prompt: 'Search ConsoleデータをBigQueryにエクスポートする手順を教えて',
        response: 'BigQueryへのエクスポート手順は以下の通りです。',
        inNotebooks: new Set(),
      },
      {
        id: 'c3',
        title: 'Google世界モデルとAI決済トレンド',
        prompt: 'ニュース要約をお願い',
        response:
          '{"title":"Genie 4","chapters":[{"title":"導入","sourceIds":["yahoo-1"],"turns":[{"speaker":"HostA","spokenText":"テスト"}]}]}',
        inNotebooks: new Set(),
      },
      {
        id: 'c4',
        title: 'パーソナライズニュースポッドキャスト',
        prompt: 'ラジオ番組台本をJSON形式で作成してください',
        response: '{}',
        inNotebooks: new Set(['agentcast']),
      },
    ];

    buildMockGeminiDom({
      initialNotebooks: ['ガジェット買取検証'],
      createMode: 'untitled_sidebar',
      chats,
    });

    const res = await runDomOrganizePastGeminiScriptsToNotebook('agentcast');
    expect(res).toMatchObject({
      ok: true,
      notebookName: 'agentcast',
      createdNotebook: true,
      totalScanned: 4,
      addedCount: 2,
      alreadyCount: 1,
      skippedCount: 1,
      failedCount: 0,
    });
    expect(chats[0].inNotebooks.has('agentcast')).toBe(true);
    expect(chats[1].inNotebooks.has('agentcast')).toBe(false);
    expect(chats[2].inNotebooks.has('agentcast')).toBe(true);
    expect(chats[3].inNotebooks.has('agentcast')).toBe(true);
  });
});
