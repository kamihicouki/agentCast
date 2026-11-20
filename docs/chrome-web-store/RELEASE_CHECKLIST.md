# Chrome Web Store 公開準備チェックリスト

## 1. 提出パッケージの作成（完了済み）
- [x] `pnpm package:cws` で `dist/agentCast-v0.6.0-cws.zip` を生成（`production` ターゲット）
- [x] `<all_urls>` 権限・個人用 Web セッション連携・`build-meta.json` 公開を自動除外済み
- [x] アイコン 4 サイズ（16 / 32 / 48 / 128px）同梱確認済み

## 2. 公開前にユーザー側で必要な作業
- [ ] **Chrome Web Store Developer アカウント登録**（初回登録料 \$5）
  - https://chrome.google.com/webstore/devconsole
- [ ] **プライバシーポリシー URL の公開**
  - `docs/chrome-web-store/PRIVACY_POLICY.md` を GitHub Pages または公開ページへ配置し、その URL を CWS 審査フォームに記入。
- [ ] **スクリーンショットの撮影（1280×800px、最低1枚・推奨3〜5枚）**
  1. STEP 4 再生画面（Napster カラーの Now Playing＋動的ハイライト台本）
  2. STEP 4 ライブラリ画面（過去番組一覧）
  3. STEP 2 巡回画面（フラットなソース一覧＋YouTube 詳細・動画要約判定）
  4. STEP 3 キュー画面（長さスライダー＋番組作成）
  5. STEP 1 設定画面（AI・音声プラン）
- [ ] **プロモーションタイル（任意・推奨）**: 440×280px の小型プロモ画像

## 3. 審査提出手順
1. Chrome Web Store Developer Dashboard で「新しいアイテム」を作成し、`dist/agentCast-v0.6.0-cws.zip` をアップロード。
2. 「ストアの掲載情報」に `docs/chrome-web-store/STORE_LISTING_JA.md` のタイトル・概要・詳細説明とスクリーンショットを入力。
3. 「プライバシー」タブに `STORE_LISTING_JA.md` の単一目的・権限正当性・プライバシーポリシー URL を入力。
4. 「公開範囲」は初回テストとして **限定公開（Unlisted）** または **テストユーザー限定** で審査を通し、問題なければ **公開（Public）** へ切り替えるのがおすすめです。
