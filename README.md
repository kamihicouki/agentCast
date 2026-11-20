# agentCast (`main` Personal Dev Branch)

自身のChromeログインセッションを活かして **X.com / Note / Zenn / Yahoo!ニュース / Google News** や開いているWeb記事を読み取り、2人掛け合いの個人用ラジオ番組に編成して再生する Chrome 拡張機能（Manifest V3）です。

MacBook + Bluetoothイヤホンでの「ながら聴き」に最適化されており、イヤホンの **「次の曲へスキップ」操作で次の話題チャプターへ移動** できます。

---

## 1. MacBook の Chrome へのインストール & 即時オートリロード手順

クラウド開発環境での更新を手元のローカル Chrome に即座に反映するため、`build-meta.json` の変更を検知して自動で `chrome.runtime.reload()` を実行する **Dev Auto-Reloader** を内蔵しています（※音声再生中は勝手に途切れないよう待機し、Side Panel 上に更新ボタンを表示します）。

以下の **どちらかの方法** で一度だけ Chrome に読み込ませてください。

### 方法A：Google ドライブ（デスクトップ版）経由で自動同期【コマンド操作不要】
1. MacBook に Google ドライブ（デスクトップ版）が入っている場合、マイドライブ内の `agentCast/extension-unpacked` フォルダがローカルに自動同期されます。
2. Chrome で `chrome://extensions` を開き、右上の **「デベロッパー モード」を ON** にします。
3. **「パッケージ化されていない拡張機能を読み込む」** をクリックし、同期された `agentCast/extension-unpacked` フォルダを選択します。
4. 以降、クラウド側で `pnpm sync:gdrive` が実行されるたびに数秒でローカルへ同期され、Chrome 拡張機能が自動リロードされます。

### 方法B：GitHub クローン + ローカル監視スクリプト（またはローカル開発）
```bash
git clone https://github.com/kamihicouki/agentCast.git
cd agentCast
pnpm install
pnpm build
```
- `chrome://extensions` から `agentCast/dist/chrome-mv3` を「パッケージ化されていない拡張機能を読み込む」で指定します。
- **クラウドからの `git push` を自動追従する場合**:
  ```bash
  chmod +x scripts/mac-watch.sh
  ./scripts/mac-watch.sh
  ```
- **ローカルで直接コードを編集する場合（ファイル保存で自動ビルド＆Chrome自動リロード）**:
  ```bash
  pnpm dev
  ```

---

## 2. ご契約プラン別の初期設定（Side Panel →「設定」タブ）

### Google AI Pro / Ultra をご契約の場合
- **おすすめ構成**: 台本生成＝`Gemini API 直結` ＋ 音声合成＝`Gemini Multi-Speaker TTS`
  - Google AI Studio 無料枠キー、または Google Developer Program 特典の月次 GenAI クレジット（Pro: 月\$10 / Ultra: 月\$40）の API キーを設定すると、1回の生成で自然な男女2人の掛け合いラジオ音声が合成されます。
- **APIキーなしですぐ使う場合**: 台本生成＝`Gemini Web セッション連携` ＋ 音声合成＝`macOS Web Speech` を選択すると、Chrome でログイン中の `gemini.google.com` セッションを使って台本を生成します。

### ChatGPT Plus / Pro をご契約の場合
- **APIキーなしですぐ使う場合**: 台本生成＝`ChatGPT Plus/Pro Web セッション連携` ＋ 音声合成＝`macOS Web Speech` を選択すると、Chrome でログイン中の `chatgpt.com` セッションを使って追加課金ゼロで台本を生成し、macOS の日本語音声で2話者再生します。

---

## 2.5 「動向」タブ（v0.4.0〜）：登録チャンネル・フォロー動向レーダー
- **取り込み**: 「YouTube 登録チャンネルを取り込む」（`/feed/channels`）／「X のフォローを取り込む」（`/<handle>/following`）。X は取り込み直後は全て OFF なので、監視したい人だけ ON にします。URL・@ハンドルで個別追加も可能。
- **動向をチェック**: YouTube は各チャンネルの公開 RSS をタブなしで並列取得、X は「agentCast 巡回中」タブでプロフィールを順番に確認（1回あたり上限あり）。前回チェック以降の投稿があれば 🟢動きあり、なければ ⚪動きなし（最終投稿日を表示）。
- **🧠 要約して判断**: 字幕（日本語優先）→ Gemini 動画理解 → 概要欄 の順で要約し、タイムスタンプ付き要点と「見る／流し見／スキップ」判定を表示。「今開いている YouTube 動画を要約」も可能。
- **🎙 動向を番組化**: 動きあり／なしサマリー＋新着を2人掛け合い番組にします。設定で「巡回して番組作成」に含めることもできます。

---

## 3. ブランチ運用・バージョニング方針
- **`main` ブランチ（現在）**: 自分専用のフル機能版（`<all_urls>` 権限、Dev Auto-Reloader、WebセッションAIブリッジ有効）
- **`production` ビルド (`pnpm build:prod`)**: 将来 Chrome Web Store へ公開する際の最小権限ビルド（`optional_host_permissions` 化、個人用ブリッジ・自動リローダー除外）
- **バージョニング (`x.y.z` / SemVer)**:
  - `package.json` の `version` を単一のソースとし、ビルド時に `manifest.json`・`build-meta.json`・Side Panel ヘッダー表示へ自動反映します。
  - **新規機能追加**: `y`（マイナー）をインクリメントし `z` を `0` にリセット（例: `0.1.0` → `0.2.0`）。
  - **不具合修正・小改善**: `z`（パッチ）をインクリメント（例: `0.2.0` → `0.2.1`）。
  - **並列開発・複合変更**: 変更内容の中で最も影響の大きい区分（機能追加を含む場合は `y`）を選定します。
