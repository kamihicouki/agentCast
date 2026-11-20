# Chrome Web Store 公開＆自動デプロイ設定チェックリスト

`production` ブランチへマージ（push）すると、[chrome-web-store.yml](../../.github/workflows/chrome-web-store.yml) が自動的に以下を実行します：

1. **`package` ジョブ**: `pnpm typecheck` → `pnpm test` → `pnpm package:cws`（`dist/agentCast-v<version>-cws.zip` の生成＆マニフェスト検証）
2. **`release` ジョブ**: GitHub Release `v<version>` を自動作成し、提出用 ZIP を添付
3. **`submit` ジョブ**: `CWS_PUBLISH_ENABLED == 'true'` のとき、Google Cloud Workload Identity Federation (OIDC) でアクセストークンを取得し、[scripts/publish-store.mjs](../../scripts/publish-store.mjs) 経由で Chrome Web Store Publish API v2 へアップロード＆審査提出

---

## 1. 初回のみの準備（Chrome Web Store アイテム登録）
※ Chrome Web Store API では**新規アイテムの作成自体はできない**ため、初回 1 回だけ手動で下書きアイテムを作成して `Extension ID` を取得します。

- [ ] [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) で「新しいアイテム」を作成
- [ ] `dist/agentCast-v<version>-cws.zip`（または同じ版の GitHub Release 添付 ZIP）をアップロードして **アイテム ID（32文字の英小文字 `a-p`）** を控える
- [ ] 「ストアの掲載情報」と「プライバシー」タブに [STORE_LISTING_JA.md](./STORE_LISTING_JA.md) と [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) の内容、およびスクリーンショット（1280×800px、3〜5枚）を設定

---

## 2. GitHub Environment & Variables の設定（自動公開の有効化）
`agy-in-chrome` で作成済みの Google Cloud Workload Identity Pool / Service Account をそのまま再利用できます（GCP 側で `kamihicouki/agentCast` リポジトリの OIDC 属性条件を追加してください）。

1. GitHub リポジトリ `Settings → Environments` で **`chrome-web-store`** 環境を作成（Deployment branches を `production` に限定推奨）。
2. `chrome-web-store` 環境の **Environment variables** に認証とアイテム指定の4項目を設定します。自動提出のスイッチは **Repository variable** に置きます。

| Variable 名 | 設定値 |
|---|---|
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | GCP Workload Identity Provider の完全リソース名（例: `projects/.../locations/global/workloadIdentityPools/.../providers/...`） |
| `CWS_SERVICE_ACCOUNT` | Chrome Web Store 権限を持つ GCP サービスアカウントのメールアドレス |
| `CWS_PUBLISHER_ID` | Chrome Web Store の Publisher ID（Developer Dashboard の「アカウント」画面で確認） |
| `CWS_EXTENSION_ID` | 手順 1 で取得した agentCast の 32 文字アイテム ID |

`CWS_PUBLISH_ENABLED` は `Settings → Secrets and variables → Actions → Variables` の **Repository variables** で管理します。
`jobs.submit.if` はジョブ開始前に評価されるため、開始後に使える Environment variable では自動提出の開始条件を満たせません。初回の手動提出中や疎通確認前は未設定または `false` にします。
[GitHub Actions の変数スコープと優先順位](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#configuration-variable-precedence)

---

## 3. 疎通確認と自動公開の運用フロー
1. **アクセス疎通確認（提出なし）**:
   - GitHub の `Actions → Chrome Web Store → Run workflow` を **`production` ブランチ・`verify_access = true`** で手動実行。
   - `Chrome Web Store access verified for <extension_id>.` と現在のステータスが表示されれば OIDC 認証・権限 OK です。
2. **自動公開 ON**:
   - 自動提出を有効にするときは、Repository variable `CWS_PUBLISH_ENABLED` を `true` に設定します。
3. **今後のリリース手順**:
   - `main` で開発＆バージョン更新（`package.json` の `version` を更新）
   - `main` → `production` へ PR マージ（または push）するだけで、テスト → CWS ZIP 生成 → GitHub Release 作成 → Chrome Web Store 自動アップロード＆審査提出まで全自動で完了します。
