import { detectZoneFromPath } from "./zoneDetector";

export interface ChunkingOptions {
  maxTokens?: number;
  overlapTokens?: number;
  filePath?: string;
}

export interface ChunkResult {
  text: string;
  zone: string;
}

/**
 * Семантический чанкер для исходного кода и текста.
 * Разбивает текст на блоки, стараясь не разрывать логические конструкции (функции, классы),
 * и добавляет перекрытие (overlap) для сохранения контекста между чанками.
 */
export class SemanticChunker {
  // Приблизительная конвертация: 1 токен ≈ 4 символа для стандартного кода/текста
  private static CHARS_PER_TOKEN = 4;

  /**
   * Разбивает текст на массив чанков.
   * @param text Исходный текст (код)
   * @param options Настройки размера чанка и перекрытия
   * @returns Массив объектов (текст чанка и его зона)
   */
  static chunkText(text: string, options: ChunkingOptions = {}): ChunkResult[] {
    const maxChars = (options.maxTokens || 512) * this.CHARS_PER_TOKEN;
    const overlapChars = (options.overlapTokens || 50) * this.CHARS_PER_TOKEN;
    const zone = options.filePath ? detectZoneFromPath(options.filePath) : "General";
    
    const chunks: string[] = [];
    
    // Поиск семантических границ: двойной перенос строки ИЛИ начало объявления структуры
    // Используем позитивный просмотр вперед (?=...), чтобы не удалять сами разделители
    const boundaries = text.split(/(?=\n\n|\n(?:class|function|const|let|var|interface|type|export|import)\s)/g);
    
    let currentChunk = "";

    for (const block of boundaries) {
      // Если добавление следующего блока превысит лимит и текущий чанк не пуст
      if ((currentChunk.length + block.length) > maxChars && currentChunk.length > 0) {
        // 1. Сохраняем текущий накопленный чанк
        chunks.push(currentChunk.trim());
        
        // 2. Формируем начало следующего чанка (нахлест/overlap)
        // Берем конец предыдущего чанка размером overlapChars
        const overlapStart = Math.max(0, currentChunk.length - overlapChars);
        const overlapText = currentChunk.substring(overlapStart);
        
        // Начинаем новый чанк: нахлест + новый блок
        currentChunk = overlapText + block;
      } else {
        // Иначе просто приклеиваем блок к текущему чанку
        currentChunk += block;
      }
    }

    // Не забываем добавить последний хвост
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    // Fallback: Если какой-то чанк получился гигантским (например, минифицированный код),
    // принудительно дробим его, чтобы не уронить Ollama (OOM / 500 Error).
    const finalChunks: string[] = [];
    const ABSOLUTE_MAX_CHARS = 8000;
    
    for (const chunk of chunks) {
      if (chunk.length > ABSOLUTE_MAX_CHARS) {
        for (let j = 0; j < chunk.length; j += ABSOLUTE_MAX_CHARS) {
          finalChunks.push(chunk.substring(j, j + ABSOLUTE_MAX_CHARS));
        }
      } else {
        finalChunks.push(chunk);
      }
    }

    return finalChunks.map(chunk => ({ text: chunk, zone }));
  }
}
