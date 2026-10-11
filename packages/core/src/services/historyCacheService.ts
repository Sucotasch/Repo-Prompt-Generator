/**
 * HistoryCacheService
 *
 * Persists generated prompts so the last result survives an app restart and
 * past generations stay reachable. Follows the same storage pattern as
 * EmbeddingCacheService: entry content lives in Cache Storage (large,
 * quota-friendly), the small metadata index lives in localStorage.
 */

export interface HistoryEntryMeta {
  id: string;
  sourceLabel: string;
  templateName: string;
  model: string;
  fileName: string;
  createdAt: number;
  size: number;
}

export class HistoryCacheService {
  private static CACHE_NAME = "prompt-history-v1";
  private static INDEX_KEY = "prompt_history_index_v1";
  private static MAX_ENTRIES = 20;

  /**
   * Returns entry metadata, newest first.
   */
  public static async listEntries(): Promise<HistoryEntryMeta[]> {
    try {
      const raw = localStorage.getItem(this.INDEX_KEY);
      const entries: HistoryEntryMeta[] = raw ? JSON.parse(raw) : [];
      return entries.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      console.warn("[HistoryCache] Failed to read index:", e);
      return [];
    }
  }

  /**
   * Saves a generated prompt and evicts entries beyond MAX_ENTRIES.
   */
  public static async saveEntry(entry: {
    content: string;
    sourceLabel: string;
    templateName: string;
    model: string;
    fileName: string;
  }): Promise<void> {
    try {
      const cache = await caches.open(this.CACHE_NAME);
      const meta: HistoryEntryMeta = {
        id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceLabel: entry.sourceLabel,
        templateName: entry.templateName,
        model: entry.model,
        fileName: entry.fileName,
        createdAt: Date.now(),
        size: entry.content.length,
      };
      await cache.put(
        `/${meta.id}`,
        new Response(JSON.stringify({ content: entry.content }), {
          headers: { "Content-Type": "application/json" },
        }),
      );

      const entries = await this.listEntries();
      entries.unshift(meta);
      const evicted = entries.splice(this.MAX_ENTRIES);
      localStorage.setItem(this.INDEX_KEY, JSON.stringify(entries));

      for (const old of evicted) {
        await cache.delete(`/${old.id}`);
      }
    } catch (e) {
      console.warn("[HistoryCache] Save failed:", e);
    }
  }

  /**
   * Loads the full prompt text for one entry.
   */
  public static async getContent(id: string): Promise<string | null> {
    try {
      const cache = await caches.open(this.CACHE_NAME);
      const response = await cache.match(`/${id}`);
      if (response) {
        const data = await response.json();
        return typeof data.content === "string" ? data.content : null;
      }
    } catch (e) {
      console.warn("[HistoryCache] Read failed:", e);
    }
    return null;
  }

  public static async deleteEntry(id: string): Promise<void> {
    try {
      const cache = await caches.open(this.CACHE_NAME);
      await cache.delete(`/${id}`);
      const entries = (await this.listEntries()).filter((e) => e.id !== id);
      localStorage.setItem(this.INDEX_KEY, JSON.stringify(entries));
    } catch (e) {
      console.warn("[HistoryCache] Delete failed:", e);
    }
  }

  public static async clear(): Promise<void> {
    try {
      const cache = await caches.open(this.CACHE_NAME);
      const entries = await this.listEntries();
      for (const entry of entries) {
        await cache.delete(`/${entry.id}`);
      }
      localStorage.removeItem(this.INDEX_KEY);
    } catch (e) {
      console.warn("[HistoryCache] Clear failed:", e);
    }
  }
}
