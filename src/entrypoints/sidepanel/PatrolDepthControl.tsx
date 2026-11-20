import React from 'react';
import {
  PATROL_DEPTH_PRESET_META,
  buildPatrolDepthPreset,
  type PatrolDepthConfig,
  type PatrolDepthPreset,
  type SourceId,
} from '../../shared/types';

interface PatrolDepthControlProps {
  sourceId?: SourceId;
  value: PatrolDepthConfig;
  onChange: (next: PatrolDepthConfig) => void;
}

const PRESETS: Exclude<PatrolDepthPreset, 'custom'>[] = ['shallow', 'standard', 'deep'];

export function PatrolDepthControl({ sourceId, value, onChange }: PatrolDepthControlProps) {
  const applyPreset = (preset: Exclude<PatrolDepthPreset, 'custom'>) => {
    onChange(buildPatrolDepthPreset(preset, sourceId));
  };

  const patchCustom = (patch: Partial<PatrolDepthConfig>) => {
    onChange({
      ...value,
      ...patch,
      preset: 'custom',
    });
  };

  return (
    <div className="n-card depth-control">
      <div className="card-head-row">
        <strong>巡回の深さ</strong>
        <span className={`depth-pill is-${value.preset}`}>
          {PATROL_DEPTH_PRESET_META[value.preset].label}
        </span>
      </div>

      <div className="segmented segmented-3" role="radiogroup" aria-label="巡回の深さプリセット">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`segment ${value.preset === p ? 'is-active' : ''}`}
            onClick={() => applyPreset(p)}
          >
            {PATROL_DEPTH_PRESET_META[p].label}
          </button>
        ))}
      </div>

      <p className="depth-summary-line">
        スクロール <strong>{value.scrollSteps}回</strong> ・ 最大 <strong>{value.maxItems}件</strong> ・ 本文展開{' '}
        <strong>{value.deepFetchLimit}件</strong>
        {value.followOutboundLinks ? ' ・ リンク先追跡ON' : ''}
      </p>

      <details className="extract-details">
        <summary>詳細パラメータを微調整</summary>
        <div className="depth-sliders">
          <div className="slider-box">
            <div className="slider-meta-row">
              <span className="field-label">スクロール回数</span>
              <span className="mono-inline">{value.scrollSteps} 回</span>
            </div>
            <input
              type="range"
              min={0}
              max={6}
              step={1}
              value={value.scrollSteps}
              onChange={(e) => patchCustom({ scrollSteps: Number(e.target.value) })}
              className="n-slider"
            />
          </div>

          <div className="slider-box">
            <div className="slider-meta-row">
              <span className="field-label">1回の最大取得件数</span>
              <span className="mono-inline">{value.maxItems} 件</span>
            </div>
            <input
              type="range"
              min={3}
              max={30}
              step={1}
              value={value.maxItems}
              onChange={(e) => patchCustom({ maxItems: Number(e.target.value) })}
              className="n-slider"
            />
          </div>

          <div className="slider-box">
            <div className="slider-meta-row">
              <span className="field-label">記事本文・動画詳細の展開件数</span>
              <span className="mono-inline">{value.deepFetchLimit} 件</span>
            </div>
            <input
              type="range"
              min={0}
              max={8}
              step={1}
              value={value.deepFetchLimit}
              onChange={(e) => patchCustom({ deepFetchLimit: Number(e.target.value) })}
              className="n-slider"
            />
          </div>

          <div className="toggle-row">
            <span>引用・外部リンク先（X / RSS等）の本文も追跡する</span>
            <input
              type="checkbox"
              checked={value.followOutboundLinks}
              onChange={(e) => patchCustom({ followOutboundLinks: e.target.checked })}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
