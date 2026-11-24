/**
 * Fault-tolerant JSON object extractor and repair parser for LLM responses.
 *
 * Handles common issues produced by long-form LLM JSON outputs (30KB+ podcast scripts,
 * Web Gemini / ChatGPT DOM captures, Gemini / OpenAI API responses):
 * - Markdown ```json fences (both closed and unclosed/truncated) and surrounding prose
 * - Missing commas between array elements or object properties
 * - Trailing or duplicate commas
 * - Unescaped double quotes, raw newlines/tabs/control chars, and invalid backslash escapes inside strings
 * - Single-line (//) and block (/* *\/) comments outside strings
 * - Mismatched closing delimiters ('}' instead of ']' or omitted ']' / '}')
 * - Truncated JSON (e.g. MAX_TOKENS or premature stream stop) by cleanly auto-closing open structures
 */

export interface ParseJsonRepairOptions {
  /** Keys expected on the target JSON object (e.g. ['chapters', 'turns', 'title']). */
  preferKeys?: string[];
}

type ArrayFrame = {
  type: 'array';
  state: 'start' | 'after_value' | 'after_comma';
};

type ObjectFrame = {
  type: 'object';
  state: 'start' | 'after_key' | 'after_colon' | 'after_value' | 'after_comma';
};

type ContainerFrame = ArrayFrame | ObjectFrame;

function isWhitespace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\r' ||
    ch === '\n' ||
    ch === '\uFEFF' ||
    ch === '\u00A0'
  );
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F')
  );
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isQuoteLike(ch: string): boolean {
  return ch === '"' || ch === '\u201C' || ch === '\u201D';
}

function skipWsAndComments(src: string, idx: number): number {
  const len = src.length;
  let i = idx;
  while (i < len) {
    const ch = src[i];
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && i + 1 < len) {
      if (src[i + 1] === '/') {
        i += 2;
        while (i < len && src[i] !== '\n' && src[i] !== '\r') i++;
        continue;
      }
      if (src[i + 1] === '*') {
        i += 2;
        while (i + 1 < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = i + 1 < len ? i + 2 : len;
        continue;
      }
    }
    break;
  }
  return i;
}

/**
 * Checks whether `src` at `idx` starts a JSON object property key (`"key":`).
 */
function looksLikeObjectKeyStart(src: string, idx: number): boolean {
  const len = src.length;
  if (idx >= len || !isQuoteLike(src[idx])) return false;
  let i = idx + 1;
  const maxEnd = Math.min(len, idx + 100);
  while (i < maxEnd) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return false;
    if (isQuoteLike(ch)) {
      const after = skipWsAndComments(src, i + 1);
      return after < len && src[after] === ':';
    }
    i++;
  }
  return false;
}

/**
 * Checks whether `src` at `idx` starts a truncated key right before EOF (`"partialKey<EOF>`).
 */
function looksLikeTruncatedKeyAtEof(src: string, idx: number): boolean {
  const len = src.length;
  if (idx >= len || !isQuoteLike(src[idx])) return false;
  if (len - idx > 80) return false;
  for (let i = idx + 1; i < len; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (isQuoteLike(ch) || ch === '\n' || ch === '\r') return false;
  }
  return true;
}

/**
 * Heuristic to distinguish a real closing `"` of a JSON string from an unescaped
 * inner double quote inside Japanese/English text (e.g. `"いわゆる"AI"です"`).
 */
function isRealClosingQuote(
  src: string,
  quoteIdx: number,
  stack: ContainerFrame[],
  isKey: boolean
): boolean {
  const len = src.length;
  let sawNewline = false;
  let i = quoteIdx + 1;
  while (i < len) {
    const ch = src[i];
    if (ch === '\n' || ch === '\r') {
      sawNewline = true;
      i++;
      continue;
    }
    if (isWhitespace(ch)) {
      i++;
      continue;
    }
    break;
  }
  const nextIdx = skipWsAndComments(src, i);
  if (nextIdx >= len) return true;

  const ch = src[nextIdx];
  if (isKey) {
    return ch === ':';
  }

  const top = stack[stack.length - 1];

  if (ch === '}' || ch === ']') {
    // Guard against embedded JSON snippets inside prose, e.g. `"例は{"a":"b"}です"`
    if (stack.length <= 1) return true;
    const afterClose = skipWsAndComments(src, nextIdx + 1);
    if (afterClose >= len) return true;
    const ac = src[afterClose];
    if (ac === ',' || ac === '}' || ac === ']' || ac === '{' || ac === '[') return true;
    // Check if there is a newline between '}'/']' and whatever follows
    for (let k = nextIdx + 1; k < afterClose; k++) {
      if (src[k] === '\n' || src[k] === '\r') return true;
    }
    if (looksLikeObjectKeyStart(src, afterClose)) return true;
    // Only treat as embedded snippet if another closing quote appears later on the same line
    for (let k = afterClose; k < len && src[k] !== '\n' && src[k] !== '\r'; k++) {
      if (src[k] === '\\') {
        k++;
        continue;
      }
      if (src[k] === '"') return false;
    }
    return true;
  }

  if (ch === ',') {
    const afterComma = skipWsAndComments(src, nextIdx + 1);
    if (afterComma >= len) return true;
    const ac = src[afterComma];

    if (top?.type === 'object') {
      if (ac === '}' || ac === ']') return true;
      if (looksLikeObjectKeyStart(src, afterComma)) return true;
      if (looksLikeTruncatedKeyAtEof(src, afterComma)) return true;
      return false;
    }

    if (top?.type === 'array') {
      if (
        ac === ']' ||
        ac === '}' ||
        ac === '{' ||
        ac === '[' ||
        ac === '-' ||
        isDigit(ac) ||
        ac === 't' ||
        ac === 'f' ||
        ac === 'n'
      ) {
        return true;
      }
      if (isQuoteLike(ac)) {
        // If there was a newline around the comma, it's definitely the next array element
        for (let k = quoteIdx + 1; k < afterComma; k++) {
          if (src[k] === '\n' || src[k] === '\r') return true;
        }
        // Same-line comma followed by `"..."`: check if that second quote closes cleanly
        // (guards against `"機能は"高速", "軽量"です"` inside a string array)
        let j = afterComma + 1;
        while (j < len) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '\n' || src[j] === '\r') return true;
          if (isQuoteLike(src[j])) {
            const afterSecond = skipWsAndComments(src, j + 1);
            if (afterSecond >= len) return true;
            const sc = src[afterSecond];
            return sc === ',' || sc === ']' || sc === '}' || sc === '\n' || sc === '\r';
          }
          j++;
        }
        return true;
      }
      return false;
    }

    return true;
  }

  // Missing comma at end of line before the next property or element
  if (sawNewline) {
    if (top?.type === 'object') {
      return looksLikeObjectKeyStart(src, nextIdx) || looksLikeTruncatedKeyAtEof(src, nextIdx);
    }
    if (top?.type === 'array') {
      return (
        ch === '{' ||
        ch === '[' ||
        isQuoteLike(ch) ||
        ch === '-' ||
        isDigit(ch) ||
        ch === 't' ||
        ch === 'f' ||
        ch === 'n'
      );
    }
  }

  // Missing comma on same line inside an array before '{', '[', or whitespace-separated next string element
  if (top?.type === 'array') {
    if (ch === '{' || ch === '[') return true;
    if (isQuoteLike(ch) && nextIdx > quoteIdx + 1) {
      let j = nextIdx + 1;
      while (j < len) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '\n' || src[j] === '\r') break;
        if (isQuoteLike(src[j])) {
          const afterNext = skipWsAndComments(src, j + 1);
          if (afterNext >= len) return true;
          const nc = src[afterNext];
          return nc === ',' || nc === ']' || nc === '}' || isQuoteLike(nc);
        }
        j++;
      }
    }
  }

  return false;
}

function readJsonString(
  src: string,
  startIdx: number,
  stack: ContainerFrame[],
  isKey: boolean
): { text: string; nextIdx: number } {
  const len = src.length;
  const openedWithSmartQuote = src[startIdx] !== '"';
  let out = '"';
  let i = startIdx + 1; // skip opening quote

  while (i < len) {
    const ch = src[i];

    if (ch === '\\') {
      if (i + 1 >= len) {
        // Dangling backslash right at EOF (truncated string) -> drop it
        i = len;
        break;
      }
      const next = src[i + 1];
      if (
        next === '"' ||
        next === '\\' ||
        next === '/' ||
        next === 'b' ||
        next === 'f' ||
        next === 'n' ||
        next === 'r' ||
        next === 't'
      ) {
        out += '\\' + next;
        i += 2;
        continue;
      }
      if (
        next === 'u' &&
        i + 5 < len &&
        isHexDigit(src[i + 2]) &&
        isHexDigit(src[i + 3]) &&
        isHexDigit(src[i + 4]) &&
        isHexDigit(src[i + 5])
      ) {
        out += src.slice(i, i + 6);
        i += 6;
        continue;
      }
      if (next === "'") {
        // Invalid JSON escape \' -> plain single quote
        out += "'";
        i += 2;
        continue;
      }
      // Invalid escape sequence (e.g. \_, \s, \d, \w, truncated \u) -> escape the backslash
      out += '\\\\' + next;
      i += 2;
      continue;
    }

    if (ch === '"' || (openedWithSmartQuote && ch === '\u201D')) {
      if (isRealClosingQuote(src, i, stack, isKey)) {
        out += '"';
        return { text: out, nextIdx: i + 1 };
      }
      // Unescaped double quote inside string content
      out += ch === '"' ? '\\"' : ch;
      i++;
      continue;
    }

    if (ch === '\n') {
      out += '\\n';
      i++;
      continue;
    }
    if (ch === '\r') {
      if (i + 1 < len && src[i + 1] === '\n') {
        out += '\\n';
        i += 2;
      } else {
        out += '\\r';
        i++;
      }
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      i++;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  // Reached EOF inside an unclosed string -> auto-close
  out += '"';
  return { text: out, nextIdx: len };
}

function readJsonNumber(src: string, startIdx: number): { text: string; nextIdx: number } {
  const len = src.length;
  let i = startIdx;
  if (src[i] === '-') i++;
  while (i < len && isDigit(src[i])) i++;
  if (i < len && src[i] === '.') {
    i++;
    while (i < len && isDigit(src[i])) i++;
  }
  if (i < len && (src[i] === 'e' || src[i] === 'E')) {
    i++;
    if (i < len && (src[i] === '+' || src[i] === '-')) i++;
    while (i < len && isDigit(src[i])) i++;
  }
  let raw = src.slice(startIdx, i);
  // Strip incomplete trailing decimal/exponent from truncated numbers
  raw = raw.replace(/(?:[eE][+-]?|\.)$/, '');
  if (!raw || raw === '-' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    // Normalize leading zeros like 01 -> 1 or fallback to 0
    const normalized = raw.replace(/^(-?)0+(\d)/, '$1$2');
    raw = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(normalized) ? normalized : '0';
  }
  return { text: raw, nextIdx: i };
}

/**
 * Repairs malformed or truncated JSON starting from the first `{` in `input` and
 * returns a strictly parseable JSON string.
 */
export function repairJsonObjectText(input: string): string {
  const startBrace = input.indexOf('{');
  if (startBrace < 0) return input;

  const src = input;
  const len = src.length;
  const stack: ContainerFrame[] = [];
  let out = '';
  let i = startBrace;

  const markValueComplete = () => {
    const parent = stack[stack.length - 1];
    if (!parent) return;
    parent.state = 'after_value';
  };

  const emitCommaIfNeeded = (frame: ContainerFrame) => {
    if (frame.state === 'after_comma' || frame.state === 'after_value') {
      out += ',';
    }
  };

  const closeTopFrame = () => {
    const frame = stack.pop();
    if (!frame) return;
    if (frame.type === 'object') {
      if (frame.state === 'after_key') {
        out += ':null';
      } else if (frame.state === 'after_colon') {
        out += 'null';
      }
      out += '}';
    } else {
      out += ']';
    }
    markValueComplete();
  };

  while (i < len) {
    i = skipWsAndComments(src, i);
    if (i >= len) break;

    const ch = src[i];
    const top = stack[stack.length - 1];

    // Root level (before opening '{')
    if (!top) {
      if (ch === '{') {
        out += '{';
        stack.push({ type: 'object', state: 'start' });
        i++;
        continue;
      }
      break;
    }

    // --- Inside an OBJECT ---
    if (top.type === 'object') {
      if (top.state === 'start' || top.state === 'after_comma' || top.state === 'after_value') {
        if (ch === '}') {
          closeTopFrame();
          i++;
          if (stack.length === 0) return out;
          continue;
        }
        if (ch === ']') {
          // Mismatched ']' while inside an object
          const hasParentArray = stack.length >= 2 && stack[stack.length - 2].type === 'array';
          const after = skipWsAndComments(src, i + 1);
          const nextCh = after < len ? src[after] : '';
          closeTopFrame();
          if (stack.length === 0) return out;
          if (hasParentArray) {
            // Decide whether this ']' was a typo for '}' or a real array closer after an omitted '}'
            const afterComma = nextCh === ',' ? skipWsAndComments(src, after + 1) : -1;
            const afterCommaCh = afterComma >= 0 && afterComma < len ? src[afterComma] : '';
            const wasTypoForBrace =
              nextCh === ']' || (nextCh === ',' && (afterCommaCh === '{' || afterCommaCh === ']'));
            if (wasTypoForBrace) {
              i++;
            }
            // Otherwise do not advance `i`: let next iteration close the enclosing array with this ']'
          } else {
            i++;
          }
          continue;
        }
        if (ch === ',') {
          if (top.state === 'after_value') {
            top.state = 'after_comma';
          }
          i++;
          continue;
        }
        if (isQuoteLike(ch)) {
          emitCommaIfNeeded(top);
          const str = readJsonString(src, i, stack, true);
          out += str.text;
          top.state = 'after_key';
          i = str.nextIdx;
          continue;
        }
        if (isIdentStart(ch)) {
          // Unquoted property key fallback
          let end = i + 1;
          while (end < len && isIdentPart(src[end])) end++;
          const key = src.slice(i, end);
          emitCommaIfNeeded(top);
          out += JSON.stringify(key);
          top.state = 'after_key';
          i = end;
          continue;
        }
        // Unexpected stray character inside object -> skip safely
        i++;
        continue;
      }

      if (top.state === 'after_key') {
        if (ch === ':') {
          out += ':';
          top.state = 'after_colon';
          i++;
          continue;
        }
        if (ch === '}' || ch === ']' || ch === ',') {
          out += ':null';
          top.state = 'after_value';
          continue;
        }
        // Missing ':' before value
        out += ':';
        top.state = 'after_colon';
        continue;
      }

      // top.state === 'after_colon' -> expect a value
      if (ch === '}' || ch === ']' || ch === ',') {
        out += 'null';
        top.state = 'after_value';
        continue;
      }
      // Fall through to shared value parser below
    }

    // --- Inside an ARRAY ---
    if (top.type === 'array') {
      if (ch === ']') {
        closeTopFrame();
        i++;
        if (stack.length === 0) return out;
        continue;
      }
      if (ch === '}') {
        // Mismatched '}' while inside an array (e.g. omitted ']' or typo '}' for ']')
        const hasParentObject = stack.length >= 2 && stack[stack.length - 2].type === 'object';
        const after = skipWsAndComments(src, i + 1);
        const nextCh = after < len ? src[after] : '';
        closeTopFrame();
        if (stack.length === 0) return out;
        if (hasParentObject) {
          const afterComma = nextCh === ',' ? skipWsAndComments(src, after + 1) : -1;
          const wasTypoForBracket =
            nextCh === '}' ||
            looksLikeObjectKeyStart(src, after) ||
            (nextCh === ',' && afterComma >= 0 && looksLikeObjectKeyStart(src, afterComma));
          if (wasTypoForBracket) {
            i++;
          }
          // Otherwise do not advance `i`: let next iteration close the enclosing object with this '}'
        } else {
          i++;
        }
        continue;
      }
      if (ch === ',') {
        if (top.state === 'after_value') {
          top.state = 'after_comma';
        }
        i++;
        continue;
      }
      // Starting a new array element (if state === 'after_value', automatically inserts missing ',')
      emitCommaIfNeeded(top);
    }

    // --- Shared JSON value parser (for array elements and object property values) ---
    if (ch === '{') {
      out += '{';
      stack.push({ type: 'object', state: 'start' });
      i++;
      continue;
    }
    if (ch === '[') {
      out += '[';
      stack.push({ type: 'array', state: 'start' });
      i++;
      continue;
    }
    if (isQuoteLike(ch)) {
      const str = readJsonString(src, i, stack, false);
      out += str.text;
      markValueComplete();
      i = str.nextIdx;
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      const num = readJsonNumber(src, i);
      out += num.text;
      markValueComplete();
      i = num.nextIdx;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentPart(src[end])) end++;
      const word = src.slice(i, end);
      const lower = word.toLowerCase();
      if (lower === 'true' || (end >= len && 'true'.startsWith(lower))) {
        out += 'true';
      } else if (lower === 'false' || (end >= len && 'false'.startsWith(lower))) {
        out += 'false';
      } else if (
        lower === 'null' ||
        lower === 'undefined' ||
        lower === 'nan' ||
        lower === 'infinity' ||
        (end >= len && 'null'.startsWith(lower))
      ) {
        out += 'null';
      } else {
        out += JSON.stringify(word);
      }
      markValueComplete();
      i = end;
      continue;
    }

    // Unexpected stray token -> skip safely to avoid infinite loops
    i++;
  }

  // EOF reached before root closed -> cleanly close all remaining open containers
  while (stack.length > 0) {
    closeTopFrame();
  }

  return out;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function hasPreferredKey(obj: Record<string, unknown>, preferKeys?: string[]): boolean {
  if (!preferKeys || preferKeys.length === 0) return true;
  return preferKeys.some((k) => k in obj);
}

function tryStrictParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Collects plausible JSON object candidate strings from raw LLM output, handling:
 * - Outer ```json ... ``` fences (closed or truncated/unclosed)
 * - Embedded markdown fenced blocks
 * - Raw JSON objects preceded or followed by prose
 */
function collectJsonCandidates(rawText: string): string[] {
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.trim();
    if (!t || !t.includes('{') || seen.has(t)) return;
    seen.add(t);
    candidates.push(t);
  };

  // 1. If the entire output starts with a markdown code fence, strip outer fences directly
  //    (avoids false splits when JSON string content itself contains ```).
  if (/^```/i.test(trimmed)) {
    const stripped = trimmed
      .replace(/^```(?:json)?[ \t]*\r?\n?/i, '')
      .replace(/\r?\n?[ \t]*```\s*$/, '')
      .trim();
    add(stripped);
  }

  // 2. Line-anchored fenced blocks (handles both closed and unclosed/truncated blocks)
  const lineFenceRegex =
    /```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```(?=[ \t]*(?:\r?\n|$))|$)/gi;
  const fencedBlocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = lineFenceRegex.exec(trimmed)) !== null) {
    const body = match[1].trim();
    if (body.includes('{')) fencedBlocks.push(body);
  }
  fencedBlocks.sort((a, b) => b.length - a.length);
  for (const block of fencedBlocks) add(block);

  // 3. Inline fenced blocks fallback
  const inlineFenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const inlineBlocks: string[] = [];
  while ((match = inlineFenceRegex.exec(trimmed)) !== null) {
    const body = match[1].trim();
    if (body.includes('{')) inlineBlocks.push(body);
  }
  inlineBlocks.sort((a, b) => b.length - a.length);
  for (const block of inlineBlocks) add(block);

  // 4. Direct top-level `{` starts in trimmed text (skipping prose like `{context}`,
  //    and never descending into nested `{` children of an unclosed/truncated outer object)
  let searchPos = 0;
  let braceStartCount = 0;
  while (braceStartCount < 4) {
    const idx = trimmed.indexOf('{', searchPos);
    if (idx < 0) break;
    const after = skipWsAndComments(trimmed, idx + 1);
    if (after < trimmed.length && (isQuoteLike(trimmed[after]) || trimmed[after] === '}')) {
      const fromBrace = trimmed.slice(idx);
      const lastBrace = fromBrace.lastIndexOf('}');
      if (lastBrace > 0) {
        add(fromBrace.slice(0, lastBrace + 1));
      }
      add(fromBrace);
      braceStartCount++;

      // Advance past this object ONLY if it closes cleanly; if unclosed (truncated), stop!
      let depth = 0;
      let inStr = false;
      let esc = false;
      let closedAt = -1;
      for (let k = idx; k < trimmed.length; k++) {
        const c = trimmed[k];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            closedAt = k;
            break;
          }
        }
      }
      if (closedAt < 0) break;
      searchPos = closedAt + 1;
    } else {
      searchPos = idx + 1;
    }
  }

  // 5. Fallback: from very first `{`
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      add(trimmed.slice(firstBrace, lastBrace + 1));
    }
    add(trimmed.slice(firstBrace));
  }

  return candidates;
}

/**
 * Parses a JSON object from raw LLM output, using strict `JSON.parse` first and falling
 * back to deterministic structural repair + truncation recovery when needed.
 */
export function parseJsonObjectWithRepair<T extends Record<string, unknown> = Record<string, unknown>>(
  rawText: string,
  options: ParseJsonRepairOptions = {}
): { value: T; repaired: boolean } {
  const candidates = collectJsonCandidates(rawText);
  if (candidates.length === 0) {
    throw new Error('JSONオブジェクトが見つかりませんでした。');
  }

  let fallbackStrict: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  // Pass 1: Strict JSON.parse across candidates
  for (const candidate of candidates) {
    const parsed = tryStrictParseObject(candidate);
    if (parsed) {
      if (hasPreferredKey(parsed, options.preferKeys)) {
        return { value: parsed as T, repaired: false };
      }
      if (!fallbackStrict) fallbackStrict = parsed;
    }
  }

  // Pass 2: Repair + JSON.parse across candidates
  let fallbackRepaired: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      const repairedText = repairJsonObjectText(candidate);
      const parsed = JSON.parse(repairedText);
      if (isPlainObject(parsed)) {
        if (hasPreferredKey(parsed, options.preferKeys)) {
          return { value: parsed as T, repaired: true };
        }
        if (!fallbackRepaired) fallbackRepaired = parsed;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (fallbackStrict) {
    return { value: fallbackStrict as T, repaired: false };
  }
  if (fallbackRepaired) {
    return { value: fallbackRepaired as T, repaired: true };
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError || 'unknown');
  throw new Error(`JSONの解析に失敗しました: ${detail}`);
}
