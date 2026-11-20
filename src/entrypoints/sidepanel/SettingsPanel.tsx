import React from 'react';
import type {
  BuildMeta,
  DurationMode,
  ExtensionSettings,
  YouTubeVisibility,
} from '../../shared/types';
import type { RuntimeRequest } from '../../shared/messages';

const GEMINI_VOICES = ['Puck', 'Aoede', 'Kore', 'Charon', 'Fenrir', 'Leda'];

interface SettingsPanelProps {
  settings: ExtensionSettings;
  currentBuild: BuildMeta | null;
  pendingBuild: BuildMeta | null;
  isVerifyingKey: boolean;
  keyVerifyStatus: { ok: boolean; text: string } | null;
  onPatchSettings: (patch: Partial<ExtensionSettings>) => Promise<void>;
  onStartGeminiKeySetup: () => Promise<void>;
  onVerifyGeminiKey: () => Promise<void>;
  onCreateDemo: () => Promise<void>;
  onGoToPatrol: () => void;
}

export function SettingsPanel({
  settings,
  currentBuild,
  pendingBuild,
  isVerifyingKey,
  keyVerifyStatus,
  onPatchSettings,
  onStartGeminiKeySetup,
  onVerifyGeminiKey,
  onCreateDemo,
  onGoToPatrol,
}: SettingsPanelProps) {
  const isAiReady =
    settings.aiMode === 'web_chatgpt' ||
    settings.aiMode === 'web_gemini' ||
    (settings.aiMode === 'gemini_api' && Boolean(settings.geminiApiKey.trim())) ||
    (settings.aiMode === 'openai_api' && Boolean(settings.openaiApiKey.trim()));

  const durationMode: DurationMode = settings.durationMode || 'fixed';
  const durationMin = Math.max(3, Math.min(30, settings.targetDurationMin || 10));

  return (
    <section className="step-section" aria-label="STEP 1 初期設定とデフォルト">
      {/* [1] Step Header */}
      <div className="step-header">
        <div>
          <div className="step-kicker">STEP 1 / DEFAULT SETUP</div>
          <h2 className="step-title">AI・音声と番組のデフォルト設定</h2>
        </div>
        <button type="button" className="btn-ghost is-accent" onClick={onGoToPatrol}>
          次へ：巡回 →
        </button>
      </div>

      {/* [2] Primary Action Card: AI & Voice Setup */}
      <div className="n-primary-card">
        <div className="card-head-row">
          <strong>⚡ AI 台本 &amp; 音声エンジン</strong>
          <span className={`pill-badge ${isAiReady ? 'is-sage' : 'is-amber'}`}>
            {isAiReady ? '接続OK' : '未設定'}
          </span>
        </div>

        <div className="field-row" style={{ marginTop: 8 }}>
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
              void onPatchSettings({ aiMode: nextAi, ttsMode: suggestedTts });
            }}
          >
            <option value="gemini_api">
              Google AI Pro/Ultra 推奨：Gemini API 直結 (クレジット/無料枠)
            </option>
            {typeof __AGENTCAST_TARGET__ === 'undefined' || __AGENTCAST_TARGET__ === 'main' ? (
              <>
                <option value="web_chatgpt">
                  ChatGPT Plus/Pro：Webセッション連携（APIキー不要・追加課金なし）
                </option>
                <option value="web_gemini">
                  Google AI Pro/Ultra：Gemini Webセッション連携（APIキー不要）
                </option>
              </>
            ) : null}
            <option value="openai_api">OpenAI API 直結（GPT-4o / gpt-4o-mini）</option>
          </select>
        </div>

        {(settings.aiMode === 'gemini_api' || settings.ttsMode === 'gemini_tts') && (
          <div className="field-row">
            <label className="field-label" htmlFor="input-gemini-key">
              Gemini API Key（ローカルのみ保存）
            </label>
            <input
              id="input-gemini-key"
              type="password"
              className="field-input"
              placeholder="AIza..."
              value={settings.geminiApiKey}
              onChange={(e) => void onPatchSettings({ geminiApiKey: e.target.value })}
            />
            <div className="action-row-2" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void onStartGeminiKeySetup()}
              >
                ⚡ AI Studio で半自動取得
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
                  color: keyVerifyStatus.ok ? 'var(--accent-sage)' : 'var(--danger-soft)',
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
              OpenAI API Key
            </label>
            <input
              id="input-openai-key"
              type="password"
              className="field-input"
              placeholder="sk-..."
              value={settings.openaiApiKey}
              onChange={(e) => void onPatchSettings({ openaiApiKey: e.target.value })}
            />
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
            <option value="gemini_tts">Gemini Multi-Speaker TTS（自然な2人掛け合い音声）</option>
            <option value="openai_tts">OpenAI TTS（話者別MP3合成）</option>
            <option value="macos_speech">macOS Web Speech（無料・ローカル日本語音声）</option>
          </select>
        </div>
      </div>

      {/* [3] Default Program Length (Slider + Fixed/Auto) */}
      <div className="n-card">
        <div className="card-head-row">
          <strong>番組の長さ（デフォルト）</strong>
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
          <div className="slider-box" style={{ marginTop: 8 }}>
            <div className="slider-meta-row">
              <span className="field-hint" style={{ margin: 0 }}>
                スライドで任意設定（STEP 3 でもその場変更可）
              </span>
              <span className="duration-readout">{durationMin}分</span>
            </div>
            <input
              id="slider-default-duration"
              type="range"
              min={3}
              max={30}
              step={1}
              value={durationMin}
              onChange={(e) => void onPatchSettings({ targetDurationMin: Number(e.target.value) })}
              className="n-slider"
              aria-label="デフォルト番組長さ（分）"
            />
            <div className="slider-ticks">
              {[5, 10, 15, 20, 30].map((m) => (
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
          <p className="field-hint" style={{ marginTop: 6 }}>
            ✨ 収集した素材の情報量に応じて、AI が無理なく聴き切れる自然な長さ（約 5〜20 分）に自動調整します。
          </p>
        )}
      </div>

      {/* Personality, Focus & Schedule */}
      <div className="n-card">
        <h3 className="card-sub-title">パーソナリティ・関心・鮮度・スケジュール</h3>
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
          <label className="field-label">重視する関心トピック（動画の見る/見ない判定にも使用）</label>
          <input
            className="field-input"
            value={settings.focusTopics}
            onChange={(e) => void onPatchSettings({ focusTopics: e.target.value })}
          />
        </div>
        <div className="field-row">
          <label className="field-label">情報鮮度・新着ウィンドウ（時間）</label>
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
            この期間より古い記事や、過去7日間の番組と重複する話題は自動でスキップします（続報・アップデートは採用）。
          </p>
        </div>
        <div className="toggle-row">
          <span>普段の閲覧中に自動で受動ストック</span>
          <input
            type="checkbox"
            checked={settings.passiveCaptureEnabled}
            onChange={(e) => void onPatchSettings({ passiveCaptureEnabled: e.target.checked })}
          />
        </div>
        <div className="toggle-row">
          <span>毎日決まった時刻に自動巡回＆番組作成</span>
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

      {/* Publish Settings */}
      <details className="n-card extract-details">
        <summary>公開先設定（YouTube / X.com）</summary>
        <div style={{ marginTop: 10 }}>
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
            <label className="field-label">X.com 投稿先ハンドル</label>
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
          <div className="toggle-row">
            <span>X 投稿時に MP4 動画を自動添付</span>
            <input
              type="checkbox"
              checked={settings.publish.xAttachVideo}
              onChange={(e) =>
                void onPatchSettings({
                  publish: { ...settings.publish, xAttachVideo: e.target.checked },
                })
              }
            />
          </div>
        </div>
      </details>

      {/* Dev Build & Demo */}
      <div className="n-card">
        <div className="card-head-row">
          <span className="field-hint" style={{ margin: 0 }}>
            ビルド: <span className="mono-inline">{currentBuild?.buildId || 'local'}</span>
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn-secondary btn-compact" onClick={() => void onCreateDemo()}>
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
