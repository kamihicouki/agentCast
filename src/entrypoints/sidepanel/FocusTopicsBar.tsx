import React, { useMemo, useState } from 'react';
import {
  PRESET_FOCUS_TOPICS,
  addFocusTopic,
  parseFocusTopics,
  removeFocusTopic,
} from '../../shared/topic-utils';

interface FocusTopicsBarProps {
  focusTopics: string;
  onChange: (nextFocusTopics: string) => void | Promise<void>;
  compact?: boolean;
  label?: string;
}

export function FocusTopicsBar({
  focusTopics,
  onChange,
  compact = false,
  label = '重視する関心トピック',
}: FocusTopicsBarProps) {
  const [draft, setDraft] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const activeTags = useMemo(() => parseFocusTopics(focusTopics), [focusTopics]);
  const availablePresets = useMemo(
    () => PRESET_FOCUS_TOPICS.filter((t) => !activeTags.includes(t)),
    [activeTags]
  );

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    void onChange(addFocusTopic(focusTopics, trimmed));
    setDraft('');
  };

  return (
    <div className={`focus-topics-bar ${compact ? 'is-compact' : ''}`}>
      <div className="focus-topics-head">
        <span className="focus-topics-label">{label}</span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setShowSuggestions((v) => !v)}
          aria-expanded={showSuggestions}
        >
          {showSuggestions ? '閉じる' : '＋ タグ追加'}
        </button>
      </div>

      <div className="focus-topics-chips" role="list" aria-label="選択中の関心トピック">
        {activeTags.length === 0 ? (
          <span className="field-hint" style={{ margin: 0 }}>
            指定なし（全トピック均等に編成）
          </span>
        ) : (
          activeTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="topic-chip is-active"
              title={`「${tag}」を外す`}
              aria-label={`「${tag}」を関心トピックから削除`}
              onClick={() => void onChange(removeFocusTopic(focusTopics, tag))}
            >
              <span>{tag}</span>
              <span className="topic-chip-x" aria-hidden="true">
                ×
              </span>
            </button>
          ))
        )}
      </div>

      {showSuggestions && (
        <div className="focus-topics-editor">
          <div className="focus-topics-input-row">
            <input
              type="text"
              className="field-input"
              placeholder="自由に追加（例: 株、仏壇、医療）"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
            />
            <button
              type="button"
              className="btn-secondary btn-compact"
              disabled={!draft.trim()}
              onClick={handleAdd}
            >
              追加
            </button>
          </div>
          {availablePresets.length > 0 && (
            <div className="focus-topics-chips">
              {availablePresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="topic-chip is-suggestion"
                  onClick={() => void onChange(addFocusTopic(focusTopics, preset))}
                >
                  ＋ {preset}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
