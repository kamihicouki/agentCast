import React from 'react';
import {
  APP_THEMES,
  GEMINI_TTS_MODELS,
  GEMINI_VOICES,
  OPENAI_TTS_MODELS,
  type AppThemeId,
  type AutoPublishMode,
  type BuildMeta,
  type DurationMode,
  type ExtensionSettings,
  type YouTubeVisibility,
  type YtToXMediaMode,
} from '../../shared/types';
import type { RuntimeRequest } from '../../shared/messages';
import { DATA_CONSENT_REQUIRED, PRIVACY_POLICY_URL } from '../../shared/data-consent';
import { ensureHostPermissionsForUrls } from '../../shared/permissions';
import { buildYouTubeStudioUploadUrl } from '../../shared/publish-utils';
import { FocusTopicsBar } from './FocusTopicsBar';

interface SettingsPanelProps {
  settings: ExtensionSettings;
  currentBuild: BuildMeta | null;
  pendingBuild: BuildMeta | null;
  isJobRunning?: boolean;
  isVerifyingKey: boolean;
  keyVerifyStatus: { ok: boolean; text: string } | null;
  isVerifyingOpenAiKey: boolean;
  openAiKeyVerifyStatus: { ok: boolean; text: string } | null;
  isOrganizingGeminiNotebook?: boolean;
  geminiNotebookStatus?: { ok: boolean; text: string } | null;
  onPatchSettings: (patch: Partial<ExtensionSettings>) => Promise<void>;
  onStartGeminiKeySetup: () => Promise<void>;
  onVerifyGeminiKey: () => Promise<void>;
  onStartOpenAiKeySetup: () => Promise<void>;
  onVerifyOpenAiKey: () => Promise<void>;
  onOrganizeGeminiNotebook?: () => Promise<void>;
  onCreateDemo: () => Promise<void>;
  onGoToPatrol: () => void;
  onRevokeConsent?: () => void;
}

export function SettingsPanel({
  settings,
  currentBuild,
  pendingBuild,
  isJobRunning,
  isVerifyingKey,
  keyVerifyStatus,
  isVerifyingOpenAiKey,
  openAiKeyVerifyStatus,
  isOrganizingGeminiNotebook,
  geminiNotebookStatus,
  onPatchSettings,
  onStartGeminiKeySetup,
  onVerifyGeminiKey,
  onStartOpenAiKeySetup,
  onVerifyOpenAiKey,
  onOrganizeGeminiNotebook,
  onCreateDemo,
  onRevokeConsent,
}: SettingsPanelProps) {
  const isAiReady =
    settings.aiMode === 'web_chatgpt' ||
    settings.aiMode === 'web_gemini' ||
    (settings.aiMode === 'gemini_api' && Boolean(settings.geminiApiKey.trim())) ||
    (settings.aiMode === 'openai_api' && Boolean(settings.openaiApiKey.trim()));

  const isTtsReady =
    settings.ttsMode === 'macos_speech' ||
    (settings.ttsMode === 'gemini_tts' && Boolean(settings.geminiApiKey.trim())) ||
    (settings.ttsMode === 'openai_tts' && Boolean(settings.openaiApiKey.trim()));

  const isEngineReady = isAiReady && isTtsReady;
  const statusLabel = isEngineReady
    ? '接続OK'
    : isAiReady && !isTtsReady
      ? 'TTSキー未設定'
      : '未設定';

  const durationMode: DurationMode = settings.durationMode || 'fixed';
  const durationMin = Math.max(3, Math.min(60, settings.targetDurationMin || 10));
  const currentTheme: AppThemeId = settings.theme || 'braun';
  const activeThemeMeta = APP_THEMES.find((t) => t.id === currentTheme) || APP_THEMES[0];

  return (
    <section className="step-section" aria-label="設定">
      {/* Theme Selection */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>外観テーマ</strong>
          <span className="mono-pill">{activeThemeMeta.name}</span>
        </div>
        <p className="field-hint">{activeThemeMeta.description}</p>
        <div className="theme-grid" role="radiogroup" aria-label="外観テーマ選択">
          {APP_THEMES.map((t) => {
            const isActive = currentTheme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={`theme-card ${isActive ? 'is-active' : ''}`}
                onClick={() => void onPatchSettings({ theme: t.id })}
              >
                <div
                  className="theme-preview-bar"
                  style={{ background: t.swatchBg }}
                  aria-hidden="true"
                >
                  <span className="theme-preview-chip" style={{ background: t.swatchSurface }} />
                  <span className="theme-preview-chip" style={{ background: t.swatchInk, opacity: 0.7 }} />
                  <span className="theme-preview-dot" style={{ background: t.swatchAccent }} />
                </div>
                <span className="theme-card-name">{t.name}</span>
                <span className="theme-card-ja">{t.labelJa}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Side Panel Scope */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>サイドパネルの表示範囲</strong>
          <span className="mono-pill">
            {settings.sidePanelScope === 'tab' ? '開いたタブのみ' : 'ウィンドウ全体'}
          </span>
        </div>
        <p className="field-hint">
          {settings.sidePanelScope === 'tab'
            ? '他のタブへ切り替えるとサイドパネルが自動で隠れ、別作業の邪魔になりません。'
            : 'どのタブに切り替えてもサイドパネルを表示し続けます（Chrome標準動作）。'}
        </p>
        <div className="segmented segmented-2" role="radiogroup" aria-label="サイドパネルの表示範囲">
          <button
            type="button"
            role="radio"
            aria-checked={settings.sidePanelScope !== 'tab'}
            className={`segment ${settings.sidePanelScope !== 'tab' ? 'is-active' : ''}`}
            onClick={() => void onPatchSettings({ sidePanelScope: 'window' })}
          >
            ウィンドウ全体
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings.sidePanelScope === 'tab'}
            className={`segment ${settings.sidePanelScope === 'tab' ? 'is-active' : ''}`}
            onClick={() => void onPatchSettings({ sidePanelScope: 'tab' })}
          >
            開いたタブのみ
          </button>
        </div>
      </div>

      {/* AI & Voice Engine */}
      <div className="n-primary-card">
        <div className="card-head-row">
          <strong>AI 台本・音声エンジン</strong>
          <span className={`pill-badge ${isEngineReady ? 'is-sage' : 'is-amber'}`}>
            {statusLabel}
          </span>
        </div>

        <div className="field-row" style={{ marginTop: 10 }}>
          <label className="field-label" htmlFor="select-ai-mode">
            台本生成エンジン
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
              void onPatchSettings({ aiMode: nextAi, ttsMode: suggestedTts });
            }}
          >
            <option value="gemini_api">
              {DATA_CONSENT_REQUIRED ? 'Gemini API（Cloud Billing 有効）' : 'Gemini API 直結'}
            </option>
            {typeof __AGENTCAST_TARGET__ === 'undefined' || __AGENTCAST_TARGET__ === 'main' ? (
              <>
                <option value="web_chatgpt">
                  ChatGPT Plus/Pro：Webセッション連携（APIキー不要）
                </option>
                <option value="web_gemini">
                  Google AI Pro/Ultra：Gemini Webセッション連携（APIキー不要）
                </option>
              </>
            ) : null}
            <option value="openai_api">OpenAI API 直結（GPT-4o / gpt-4o-mini）</option>
          </select>
        </div>

        {onRevokeConsent && (
          <p className="field-hint">
            <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
              プライバシーポリシー
            </a>{' '}
            <button type="button" className="btn-ghost" onClick={onRevokeConsent}>
              データ取り扱いの同意を取り消す
            </button>
          </p>
        )}

        {(typeof __AGENTCAST_TARGET__ === 'undefined' || __AGENTCAST_TARGET__ === 'main') &&
          settings.aiMode === 'web_gemini' &&
          onOrganizeGeminiNotebook && (
            <div className="field-row">
              <label className="field-label">Gemini ノートブック整理（agentcast）</label>
              <p className="field-hint" style={{ marginTop: 2, marginBottom: 6 }}>
                新規作成した台本は自動で「agentcast」ノートブックに追加されます。
              </p>
              <button
                type="button"
                className="btn-secondary"
                disabled={Boolean(isOrganizingGeminiNotebook || isJobRunning)}
                onClick={() => void onOrganizeGeminiNotebook()}
              >
                {isOrganizingGeminiNotebook
                  ? '過去の台本を整理中…'
                  : '過去の台本を「agentcast」に整理'}
              </button>
              {geminiNotebookStatus && (
                <p
                  className="field-hint"
                  style={{
                    marginTop: 6,
                    color: geminiNotebookStatus.ok ? 'var(--signal-ok)' : 'var(--signal-danger)',
                  }}
                >
                  {geminiNotebookStatus.text}
                </p>
              )}
            </div>
          )}

        <div className="field-row">
          <label className="field-label" htmlFor="select-tts-mode">
            音声合成エンジン (TTS)
          </label>
          <select
            id="select-tts-mode"
            className="field-select"
            value={settings.ttsMode}
            onChange={(e) =>
              void onPatchSettings({ ttsMode: e.target.value as ExtensionSettings['ttsMode'] })
            }
          >
            <option value="gemini_tts">Gemini Multi-Speaker TTS（2人掛け合い音声）</option>
            <option value="openai_tts">OpenAI TTS（話者別MP3合成）</option>
            <option value="macos_speech">macOS Web Speech（無料・ローカル日本語）</option>
          </select>
        </div>

        {settings.ttsMode === 'gemini_tts' && (
          <div className="field-row">
            <label className="field-label" htmlFor="select-gemini-tts-model">
              Gemini TTS モデル
            </label>
            <select
              id="select-gemini-tts-model"
              className="field-select"
              value={settings.geminiTtsModel || 'gemini-3.8-flash-tts'}
              onChange={(e) => void onPatchSettings({ geminiTtsModel: e.target.value })}
            >
              {GEMINI_TTS_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {settings.ttsMode === 'openai_tts' && (
          <div className="field-row">
            <label className="field-label" htmlFor="select-openai-tts-model">
              OpenAI TTS モデル
            </label>
            <select
              id="select-openai-tts-model"
              className="field-select"
              value={settings.openaiTtsModel || 'tts-1'}
              onChange={(e) => void onPatchSettings({ openaiTtsModel: e.target.value })}
            >
              {OPENAI_TTS_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {(settings.aiMode === 'gemini_api' || settings.ttsMode === 'gemini_tts') && (
          <div className="field-row">
            <label className="field-label" htmlFor="input-gemini-key">
              Gemini API Key（ローカルのみ保存）
            </label>
            <input
              id="input-gemini-key"
              type="password"
              className="field-input"
              placeholder="AIza... または AQ...."
              value={settings.geminiApiKey}
              onChange={(e) => void onPatchSettings({ geminiApiKey: e.target.value })}
            />
            <div className="action-row-2" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void onStartGeminiKeySetup()}
              >
                AI Studio で自動連携
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={isVerifyingKey || !settings.geminiApiKey.trim()}
                onClick={() => void onVerifyGeminiKey()}
              >
                {isVerifyingKey ? '検証中…' : '接続テスト'}
              </button>
            </div>
            {keyVerifyStatus && (
              <p
                className="field-hint"
                style={{
                  color: keyVerifyStatus.ok ? 'var(--signal-ok)' : 'var(--signal-danger)',
                }}
              >
                {keyVerifyStatus.text}
              </p>
            )}
          </div>
        )}

        {(settings.aiMode === 'openai_api' || settings.ttsMode === 'openai_tts') && (
          <div className="field-row">
            <label className="field-label" htmlFor="input-openai-key">
              OpenAI API Key（ローカルのみ保存）
            </label>
            <input
              id="input-openai-key"
              type="password"
              className="field-input"
              placeholder="sk-..."
              value={settings.openaiApiKey}
              onChange={(e) => void onPatchSettings({ openaiApiKey: e.target.value })}
            />
            <div className="action-row-2" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void onStartOpenAiKeySetup()}
              >
                OpenAI で自動連携
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={isVerifyingOpenAiKey || !settings.openaiApiKey.trim()}
                onClick={() => void onVerifyOpenAiKey()}
              >
                {isVerifyingOpenAiKey ? '検証中…' : '接続テスト'}
              </button>
            </div>
            {openAiKeyVerifyStatus && (
              <p
                className="field-hint"
                style={{
                  color: openAiKeyVerifyStatus.ok ? 'var(--signal-ok)' : 'var(--signal-danger)',
                }}
              >
                {openAiKeyVerifyStatus.text}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Default Program Length */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>番組の長さ</strong>
          <div className="segmented segmented-2">
            <button
              type="button"
              className={`segment ${durationMode === 'fixed' ? 'is-active' : ''}`}
              onClick={() => void onPatchSettings({ durationMode: 'fixed' })}
            >
              固定長
            </button>
            <button
              type="button"
              className={`segment ${durationMode === 'auto' ? 'is-active' : ''}`}
              onClick={() => void onPatchSettings({ durationMode: 'auto' })}
            >
              おまかせ
            </button>
          </div>
        </div>

        {durationMode === 'fixed' ? (
          <div className="slider-box" style={{ marginTop: 10 }}>
            <div className="slider-meta-row">
              <span className="field-hint" style={{ margin: 0 }}>
                ワンクリック番組作成時の標準尺
              </span>
              <span className="duration-readout">{durationMin}分</span>
            </div>
            <input
              id="slider-default-duration"
              type="range"
              min={3}
              max={60}
              step={1}
              value={durationMin}
              onChange={(e) => void onPatchSettings({ targetDurationMin: Number(e.target.value) })}
              className="n-slider"
              aria-label="デフォルト番組長さ（分）"
            />
            <div className="slider-ticks">
              {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`tick-btn ${durationMin === m ? 'is-active' : ''}`}
                  onClick={() => void onPatchSettings({ targetDurationMin: m })}
                >
                  {m}分
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="field-hint" style={{ marginTop: 8 }}>
            収集した素材の情報量に応じて、AI が自然な長さ（約 5〜30 分）に自動調整します。
          </p>
        )}
      </div>

      {/* Personality, Focus & Schedule */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>パーソナリティ・関心・鮮度・スケジュール</strong>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="grid-2">
            <div className="field-row">
              <label className="field-label">Host A 名前</label>
              <input
                className="field-input"
                value={settings.hostAName}
                onChange={(e) => void onPatchSettings({ hostAName: e.target.value })}
              />
            </div>
            <div className="field-row">
              <label className="field-label">Host B 名前</label>
              <input
                className="field-input"
                value={settings.hostBName}
                onChange={(e) => void onPatchSettings({ hostBName: e.target.value })}
              />
            </div>
          </div>
          {settings.ttsMode === 'gemini_tts' && (
            <div className="grid-2">
              <div className="field-row">
                <label className="field-label">Host A 声色</label>
                <select
                  className="field-select"
                  value={settings.hostAVoice}
                  onChange={(e) => void onPatchSettings({ hostAVoice: e.target.value })}
                >
                  {GEMINI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <label className="field-label">Host B 声色</label>
                <select
                  className="field-select"
                  value={settings.hostBVoice}
                  onChange={(e) => void onPatchSettings({ hostBVoice: e.target.value })}
                >
                  {GEMINI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="field-row">
            <FocusTopicsBar
              focusTopics={settings.focusTopics}
              onChange={(focusTopics) => void onPatchSettings({ focusTopics })}
            />
          </div>
          <div className="field-row">
            <label className="field-label">情報鮮度ウィンドウ（時間）</label>
            <input
              type="number"
              min={6}
              max={720}
              className="field-input"
              value={settings.radarWindowHours}
              onChange={(e) =>
                void onPatchSettings({
                  radarWindowHours: Math.max(6, Number(e.target.value) || 72),
                })
              }
            />
            <p className="field-hint">
              この期間より古い記事や直近7日間の重複トピックは自動でスキップします。
            </p>
          </div>
          <div className="toggle-row">
            <div>
              <div>閲覧中の自動受動ストック（既定OFF）</div>
              <p className="field-hint">
                ON にした場合のみ、許可済みサイトの閲覧時に本文候補を自動抽出します。
              </p>
            </div>
            <input
              type="checkbox"
              checked={settings.passiveCaptureEnabled}
              onChange={(e) => void onPatchSettings({ passiveCaptureEnabled: e.target.checked })}
            />
          </div>
          <div className="toggle-row">
            <span>毎日決まった時刻に自動巡回・番組作成</span>
            <input
              type="checkbox"
              checked={settings.autoScheduleEnabled}
              onChange={(e) => void onPatchSettings({ autoScheduleEnabled: e.target.checked })}
            />
          </div>
          {settings.autoScheduleEnabled && (
            <div className="field-row">
              <label className="field-label">自動生成時刻</label>
              <input
                type="time"
                className="field-input"
                value={settings.autoScheduleTime}
                onChange={(e) => void onPatchSettings({ autoScheduleTime: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>

      {/* Publish Settings */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>自動投稿・公開先設定（YouTube / X）</strong>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="field-row">
            <label className="field-label">自動投稿の実行モード</label>
            <select
              className="field-select"
              value={settings.publish.autoPublishMode || 'full_auto'}
              onChange={(e) =>
                void onPatchSettings({
                  publish: {
                    ...settings.publish,
                    autoPublishMode: e.target.value as AutoPublishMode,
                  },
                })
              }
            >
              <option value="full_auto">完全自動（動画添付〜最終「公開/ポスト」ボタンまで自動）</option>
              <option value="manual_confirm">半自動（ガイド表示・手動確認して公開）</option>
            </select>
            <p className="field-hint">
              ログイン済みの YouTube Studio / X.com セッションを使って自動投稿します（APIキー不要・実行中も画面右下の「中止」でいつでも止められます）。
            </p>
          </div>
          <div className="toggle-row">
            <div>
              <div>番組生成完了後に自動で YouTube 公開</div>
              <p className="field-hint">
                音声合成が終わると自動で MP4 動画を作成し YouTube Studio へ公開します。
              </p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(settings.publish.autoPublishAfterGenerateYouTube)}
              onChange={(e) => {
                const checked = e.target.checked;
                void (async () => {
                  if (checked) {
                    const ytUrl = buildYouTubeStudioUploadUrl(
                      settings.publish.youtubeChannelIdOrUrl
                    );
                    if (!(await ensureHostPermissionsForUrls([ytUrl]))) return;
                  }
                  await onPatchSettings({
                    publish: { ...settings.publish, autoPublishAfterGenerateYouTube: checked },
                  });
                })();
              }}
            />
          </div>
          <div className="toggle-row">
            <div>
              <div>番組生成完了後に自動で X.com 投稿</div>
              <p className="field-hint">
                YouTube 自動公開も ON の場合は、YouTube 公開完了後に動画 URL を取得してから X へ自動投稿します。
              </p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(settings.publish.autoPublishAfterGenerateX)}
              onChange={(e) => {
                const checked = e.target.checked;
                void (async () => {
                  if (checked) {
                    if (!(await ensureHostPermissionsForUrls(['https://x.com/']))) return;
                  }
                  await onPatchSettings({
                    publish: { ...settings.publish, autoPublishAfterGenerateX: checked },
                  });
                })();
              }}
            />
          </div>
          <div className="field-row">
            <label className="field-label">YouTube チャンネルID または URL</label>
            <input
              className="field-input"
              placeholder="UC... または https://www.youtube.com/channel/UC..."
              value={settings.publish.youtubeChannelIdOrUrl}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, youtubeChannelIdOrUrl: e.target.value },
                })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">YouTube デフォルト公開範囲</label>
            <select
              className="field-select"
              value={settings.publish.youtubeDefaultVisibility}
              onChange={(e) =>
                void onPatchSettings({
                  publish: {
                    ...settings.publish,
                    youtubeDefaultVisibility: e.target.value as YouTubeVisibility,
                  },
                })
              }
            >
              <option value="unlisted">限定公開（おすすめ）</option>
              <option value="private">非公開（下書き）</option>
              <option value="public">公開</option>
            </select>
          </div>
          <div className="field-row">
            <label className="field-label">YouTube ハッシュタグ</label>
            <input
              className="field-input"
              placeholder="#agentCast #AIポッドキャスト"
              value={settings.publish.youtubeHashtags}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, youtubeHashtags: e.target.value },
                })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">X.com 投稿先ハンドル（誤爆防止チェック）</label>
            <input
              className="field-input"
              placeholder="@your_handle"
              value={settings.publish.xAccountHandle}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, xAccountHandle: e.target.value },
                })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">X.com ハッシュタグ</label>
            <input
              className="field-input"
              placeholder="#agentCast #AIラジオ"
              value={settings.publish.xHashtags}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, xHashtags: e.target.value },
                })
              }
            />
          </div>
          <div className="field-row">
            <label className="field-label">YT → X 自動連携時の X 投稿形式</label>
            <select
              className="field-select"
              value={settings.publish.ytToXMediaMode || 'link_only'}
              onChange={(e) =>
                void onPatchSettings({
                  publish: {
                    ...settings.publish,
                    ytToXMediaMode: e.target.value as YtToXMediaMode,
                  },
                })
              }
            >
              <option value="link_only">YouTube リンク添付のみ（デフォルト・高速）</option>
              <option value="link_and_video">YouTube リンク ＋ MP4 動画も添付</option>
            </select>
            <p className="field-hint">
              「YT → X 自動投稿」や生成後の自動連携では、YouTube 動画リンクの添付のみで十分です（必要に応じて MP4 動画の同時添付も選べます）。
            </p>
          </div>
          <div className="toggle-row">
            <span>YouTube 公開後の動画 URL を X 投稿本文に自動挿入</span>
            <input
              type="checkbox"
              checked={settings.publish.xIncludeYouTubeUrl !== false}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, xIncludeYouTubeUrl: e.target.checked },
                })
              }
            />
          </div>
          <div className="toggle-row">
            <span>X 単体投稿時に MP4 動画を自動添付</span>
            <input
              type="checkbox"
              checked={Boolean(settings.publish.xAttachVideo)}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, xAttachVideo: e.target.checked },
                })
              }
            />
          </div>
        </div>
      </div>

      {/* Dev Build & Demo */}
      <div className="n-card">
        <div className="card-head-row">
          <span className="field-hint" style={{ margin: 0 }}>
            Build: <span className="mono-inline">{currentBuild?.buildId || 'local'}</span>
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn-secondary btn-compact"
              onClick={() => void onCreateDemo()}
            >
              デモ試聴
            </button>
            {pendingBuild && (
              <button
                type="button"
                className="btn-primary btn-compact"
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
      </div>
    </section>
  );
}
