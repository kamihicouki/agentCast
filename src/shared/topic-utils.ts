export const PRESET_FOCUS_TOPICS = [
  'AI',
  'テクノロジー',
  '開発トレンド',
  '主要ニュース',
  'ビジネス・経済',
  'ガジェット',
  'デザイン',
  'スタートアップ',
  '科学・医療',
  'ライフスタイル',
] as const;

export function parseFocusTopics(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[・,、/／\n]+/)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function serializeFocusTopics(tags: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const trimmed = t.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join('・');
}

export function addFocusTopic(raw: string | undefined | null, tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) return serializeFocusTopics(parseFocusTopics(raw));
  return serializeFocusTopics([...parseFocusTopics(raw), trimmed]);
}

export function removeFocusTopic(raw: string | undefined | null, tag: string): string {
  const trimmed = tag.trim();
  return serializeFocusTopics(parseFocusTopics(raw).filter((t) => t !== trimmed));
}

export function toggleFocusTopic(raw: string | undefined | null, tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) return serializeFocusTopics(parseFocusTopics(raw));
  const current = parseFocusTopics(raw);
  if (current.includes(trimmed)) {
    return serializeFocusTopics(current.filter((t) => t !== trimmed));
  }
  return serializeFocusTopics([...current, trimmed]);
}
