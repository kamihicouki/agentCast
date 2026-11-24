import React, { useEffect, useMemo, useState } from 'react';
import {
  SOURCE_META,
  type DurationMode,
  type ExtensionSettings,
  type FeedItem,
} from '../../shared/types';
import type { RuntimeRequest } from '../../shared/messages';

interface QueuePanelProps {
  queue: FeedItem[];
  settings: ExtensionSettings;
  isJobRunning: boolean;
  onRemoveItem: (id: string) => Promise<void>;
  onClearQueue: () => Promise<void>;
  onGoToPatrol: () => void;
  onGoToPlayer: () => void;
  showToast: (msg: string) => void;
  setErrorBanner: (msg: string) => void;
}

export function QueuePanel({
  queue,
  settings,
  isJobRunning,
  onRemoveItem,
  onClearQueue,
  onGoToPatrol,
  onGoToPlayer,
  showToast,
  setErrorBanner,
}: QueuePanelProps) {
  const [runDurationMin, setRunDurationMin] = useState<number>(settings.targetDurationMin || 10);
  const [runDurationMode, setRunDurationMode] = useState<DurationMode>(
    settings.durationMode || 'fixed'
  );
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    setRunDurationMin(settings.targetDurationMin || 10);
    setRunDurationMode(settings.durationMode || 'fixed');
  }, [settings.targetDurationMin, settings.durationMode]);

  useEffect(() => {
    if (queue.length === 0) {
      setConfirmClear(false);
    }
  }, [queue.length]);

  const selectedItems = useMemo(
    () => queue.filter((item) => !excludedIds.has(item.id)),
    [queue, excludedIds]
  );

  const sourceBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of selectedItems) {
      const label = SOURCE_META[item.source]?.shortLabel || item.source;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries());
  }, [selectedItems]);

  const toggleItem = (id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = async () => {
    setErrorBanner('');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_EPISODE_FROM_QUEUE',
        itemIds: selectedItems.map((i) => i.id),
        durationMin: runDurationMin,
        durationMode: runDurationMode,
      } satisfies RuntimeRequest);
      if (!res?.ok) {
        setErrorBanner(res?.error || '番組生成の開始に失敗しました');
      } else {
        showToast(
          `${runDurationMode === 'auto' ? 'おまかせ尺' : `${runDurationMin}分`}で番組を作成しています…`
        );
        onGoToPlayer();
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="step-section" aria-label="素材キュー">
      {/* Source Breakdown Strip */}
      {sourceBreakdown.length > 0 && (
        <div className="n-card flow-bar">
          <div className="flow-bar-chips">
            <span className="flow-bar-label">内訳</span>
            {sourceBreakdown.map(([label, count]) => (
              <span key={label} className="source-count-chip">
                {label} {count}
              </span>
            ))}
          </div>
          <span className="mono-pill">
            {selectedItems.length}/{queue.length}
          </span>
        </div>
      )}

      {/* Compose Card */}
      <div className="n-primary-card">
        <div className="card-head-row">
          <strong>キューの素材から番組を作成</strong>
          <span className="duration-readout">
            {runDurationMode === 'auto' ? 'おまかせ' : `${runDurationMin}分`}
          </span>
        </div>

        <div className="slider-box" style={{ marginTop: 10 }}>
          <div className="slider-meta-row">
            <span className="field-hint" style={{ margin: 0 }}>
              今回の長さ
            </span>
            <button
              type="button"
              className="btn-ghost is-accent"
              onClick={() => setRunDurationMode((m) => (m === 'auto' ? 'fixed' : 'auto'))}
            >
              {runDurationMode === 'auto' ? '分数を指定' : 'おまかせにする'}
            </button>
          </div>
          {runDurationMode === 'fixed' ? (
            <>
              <input
                type="range"
                min={3}
                max={30}
                step={1}
                value={runDurationMin}
                onChange={(e) => setRunDurationMin(Number(e.target.value))}
                className="n-slider"
                aria-label="今回の番組の長さ（分）"
              />
              <div className="slider-ticks">
                {[5, 10, 15, 20, 30].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`tick-btn ${runDurationMin === m ? 'is-active' : ''}`}
                    onClick={() => setRunDurationMin(m)}
                  >
                    {m}分
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="field-hint" style={{ marginTop: 4 }}>
              選択した {selectedItems.length} 件の情報量に合わせて AI が長さを自動調整します。
            </p>
          )}
        </div>

        <div className="queue-compose-actions">
          <button
            id="btn-generate-from-queue"
            type="button"
            className="btn-primary"
            style={{ width: '100%' }}
            disabled={selectedItems.length === 0 || isJobRunning}
            onClick={() => void handleGenerate()}
          >
            選択した {selectedItems.length} 件から番組を作成・再生
          </button>

          {queue.length > 0 &&
            (confirmClear ? (
              <div className="clear-confirm-row">
                <button
                  type="button"
                  className="btn-danger-solid"
                  disabled={isJobRunning}
                  onClick={() => {
                    setConfirmClear(false);
                    void onClearQueue();
                  }}
                >
                  全 {queue.length} 件を削除
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setConfirmClear(false)}
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <button
                id="btn-clear-queue"
                type="button"
                className="btn-danger-ghost"
                style={{ width: '100%' }}
                disabled={isJobRunning}
                onClick={() => setConfirmClear(true)}
              >
                キューを空にする（{queue.length}件）
              </button>
            ))}
        </div>
      </div>

      {/* Material List */}
      {queue.length === 0 ? (
        <div className="empty-box">
          <p>未読キューは空です。ソースを巡回するか、開いているタブから取り込んでください。</p>
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: 10 }}
            onClick={onGoToPatrol}
          >
            ソース一覧へ
          </button>
        </div>
      ) : (
        <div className="queue-list">
          {queue.map((item) => {
            const checked = !excludedIds.has(item.id);
            return (
              <article key={item.id} className={`queue-item ${checked ? '' : 'is-off'}`}>
                <div className="queue-item-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleItem(item.id)}
                    aria-label={`${item.title} を番組に含める`}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="queue-meta">
                      <span className="queue-source-tag">
                        {SOURCE_META[item.source]?.shortLabel || item.source} · {item.author}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => void onRemoveItem(item.id)}
                        title="キューから削除"
                        aria-label={`${item.title} を削除`}
                      >
                        ✕
                      </button>
                    </div>
                    <h3 className="queue-title">
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.title}
                      </a>
                    </h3>
                    <p className="queue-excerpt">{item.excerpt}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
