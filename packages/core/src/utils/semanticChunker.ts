import { detectZoneFromPath } from "./zoneDetector";

export interface ChunkingOptions {
  maxTokens?: number;
  overlapTokens?: number;
  filePath?: string;
}

export interface ChunkResult {
  text: string;
  zone: string;
  startLine: number;
  endLine: number;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLineNumber(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hi + 1;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/**
 * Семантический чанкер для исходного кода и текста.
 * Разбивает текст на блоки, стараясь не разрывать логические конструкции (функции, классы),
 * добавляет перекрытие (overlap) и сохраняет точные 1-indexed номера строк.
 */
export class SemanticChunker {
  // Приблизительная конвертация: 1 токен ≈ 4 символа для стандартного кода/текста
  private static CHARS_PER_TOKEN = 4;

  static chunkText(text: string, options: ChunkingOptions = {}): ChunkResult[] {
    const maxChars = (options.maxTokens ?? 512) * this.CHARS_PER_TOKEN;
    const overlapChars = (options.overlapTokens ?? 50) * this.CHARS_PER_TOKEN;
    const zone = options.filePath ? detectZoneFromPath(options.filePath) : "General";
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lineStarts = buildLineStarts(normalized);

    const boundaries = normalized.split(/(?=\n\n|\n(?:class|function|def|struct|impl|const|let|var|interface|type|export|import)\s)/g);

    const rawChunks: { text: string; startOffset: number }[] = [];
    let currentChunk = "";
    let currentChunkOffset = 0;
    let runningOffset = 0;

    const pushTrimmedChunk = (chunkStr: string, chunkBaseOffset: number) => {
      const trimmed = chunkStr.trim();
      if (!trimmed) return;
      const leadingTrimmed = chunkStr.length - chunkStr.trimStart().length;
      rawChunks.push({
        text: trimmed,
        startOffset: chunkBaseOffset + leadingTrimmed,
      });
    };

    for (const block of boundaries) {
      if (currentChunk.length === 0) {
        currentChunkOffset = runningOffset;
      }

      if (currentChunk.length + block.length > maxChars && currentChunk.length > 0) {
        pushTrimmedChunk(currentChunk, currentChunkOffset);

        const overlapStart = Math.max(0, currentChunk.length - overlapChars);
        const overlapText = currentChunk.substring(overlapStart);
        currentChunkOffset = currentChunkOffset + overlapStart;
        currentChunk = overlapText + block;
      } else {
        currentChunk += block;
      }

      runningOffset += block.length;
    }

    if (currentChunk.trim().length > 0) {
      pushTrimmedChunk(currentChunk, currentChunkOffset);
    }

    const finalChunks: ChunkResult[] = [];
    const stepChars = Math.max(1, maxChars - overlapChars);

    for (const item of rawChunks) {
      if (item.text.length > maxChars) {
        for (let j = 0; j < item.text.length; j += stepChars) {
          const slice = item.text.substring(j, j + maxChars);
          const leading = slice.length - slice.trimStart().length;
          const trimmedSlice = slice.trim();
          if (!trimmedSlice) continue;
          const startLine = offsetToLineNumber(lineStarts, item.startOffset + j + leading);
          const endLine = startLine + countNewlines(trimmedSlice);
          finalChunks.push({ text: trimmedSlice, zone, startLine, endLine });
        }
      } else {
        const startLine = offsetToLineNumber(lineStarts, item.startOffset);
        const endLine = startLine + countNewlines(item.text);
        finalChunks.push({ text: item.text, zone, startLine, endLine });
      }
    }

    return finalChunks;
  }
}
