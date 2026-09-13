/**
 * Content Script Utilities
 */

/**
 * Simple fast hash for strings (djb2 variant).
 * Good enough for cache keying; not cryptographic.
 */
export function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Diff two texts at paragraph level.
 * Returns the character span of the first changed paragraph
 * plus one paragraph of surrounding context on each side.
 */
export function computeParagraphDiff(
  oldText: string,
  newText: string
): { changedSpan: { start: number; end: number } | undefined } {
  if (!oldText) {
    // Everything is new — send the whole text
    return { changedSpan: { start: 0, end: newText.length } };
  }

  // Split into paragraphs with their offsets
  const paragraphs = getParagraphsWithOffsets(newText);

  // Find first paragraph that changed
  const oldParas = oldText.split(/\n\n+/);
  let changedIdx = -1;

  for (let i = 0; i < paragraphs.length; i++) {
    const oldPara = oldParas[i] ?? '';
    if (paragraphs[i].text !== oldPara) {
      changedIdx = i;
      break;
    }
  }

  if (changedIdx === -1) {
    // Only appended text after existing paragraphs
    const last = paragraphs[paragraphs.length - 1];
    return { changedSpan: { start: last?.start ?? 0, end: newText.length } };
  }

  // Include one paragraph of context on each side
  const contextStart = Math.max(0, changedIdx - 1);
  const contextEnd = Math.min(paragraphs.length - 1, changedIdx + 1);

  const start = paragraphs[contextStart].start;
  const end = paragraphs[contextEnd].end;

  return { changedSpan: { start, end } };
}

interface ParagraphInfo {
  text: string;
  start: number;
  end: number;
}

function getParagraphsWithOffsets(text: string): ParagraphInfo[] {
  const result: ParagraphInfo[] = [];
  const re = /\n\n+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    result.push({
      text: text.slice(lastIndex, match.index),
      start: lastIndex,
      end: match.index,
    });
    lastIndex = match.index + match[0].length;
  }

  result.push({
    text: text.slice(lastIndex),
    start: lastIndex,
    end: text.length,
  });

  return result;
}
