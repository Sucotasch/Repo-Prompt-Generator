/**
 * EmbeddingCacheService
 * 
 * Provides persistent caching of embeddings using the browser's Cache API.
 * This significantly reduces the number of API calls to Ollama/Gemini
 * for repeated queries on the same codebase.
 */
export class EmbeddingCacheService {
  private static CACHE_PREFIX = 'repo-embeddings-v3-';

  /**
   * Generates a safe namespace string from a repo URL or identifier.
   */
  public static getNamespace(repoUrl: string): string {
    if (!repoUrl) return 'default';
    // Simple hash-like string from URL
    let hash = 0;
    for (let i = 0; i < repoUrl.length; i++) {
      const char = repoUrl.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Generates a SHA-256 hash for a given text chunk and model.
   */
  private static async generateHash(text: string, model: string): Promise<string> {
    const data = `${model}:${text}`;
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Retrieves an embedding from a specific repo namespace.
   */
  public static async getEmbedding(text: string, model: string, repoUrl: string): Promise<number[] | null> {
    try {
      const ns = this.getNamespace(repoUrl);
      const hash = await this.generateHash(text, model);
      const cache = await caches.open(`${this.CACHE_PREFIX}${ns}`);
      const response = await cache.match(`/${hash}`);
      
      if (response) {
        const data = await response.json();
        return data.embedding;
      }
    } catch (e) {
      console.warn("[EmbeddingCache] Read failed:", e);
    }
    return null;
  }

  /**
   * Saves an embedding to a specific repo namespace.
   */
  public static async saveEmbedding(text: string, model: string, embedding: number[], repoUrl: string): Promise<void> {
    try {
      const ns = this.getNamespace(repoUrl);
      const hash = await this.generateHash(text, model);
      const cache = await caches.open(`${this.CACHE_PREFIX}${ns}`);
      const response = new Response(JSON.stringify({ embedding }), {
        headers: { 'Content-Type': 'application/json' }
      });
      await cache.put(`/${hash}`, response);
    } catch (e) {
      console.warn("[EmbeddingCache] Write failed:", e);
    }
  }

  /**
   * Prunes all caches except the ones currently in use or used within the last 5 minutes.
   */
  public static async pruneUnusedCaches(activeRepoUrls: string[]): Promise<void> {
    try {
      const now = Date.now();
      const GRACE_PERIOD = 5 * 60 * 1000; // 5 minutes
      const ACTIVITY_KEY = 'embedding_cache_activity';
      
      // 1. Load activity map from localStorage
      const activityStr = localStorage.getItem(ACTIVITY_KEY);
      const activity: Record<string, number> = activityStr ? JSON.parse(activityStr) : {};

      // 2. Mark current active repos as "just used"
      const activeNamespaces = activeRepoUrls
        .filter(Boolean)
        .map(url => `${this.CACHE_PREFIX}${this.getNamespace(url)}`);
      
      activeNamespaces.forEach(ns => {
        activity[ns] = now;
      });

      // 3. Identify which caches to delete
      const cacheNames = await caches.keys();
      const namespacesToDelete: string[] = [];

      for (const name of cacheNames) {
        if (name.startsWith(this.CACHE_PREFIX)) {
          // If it's NOT currently active in UI
          if (!activeNamespaces.includes(name)) {
            const lastActive = activity[name] || 0;
            // AND it's been inactive for more than the grace period
            if (now - lastActive > GRACE_PERIOD) {
              namespacesToDelete.push(name);
            }
          }
        }
      }

      // 4. Perform deletion
      for (const name of namespacesToDelete) {
        console.log(`[EmbeddingCache] Pruning stale repo cache (inactive > 5m): ${name}`);
        await caches.delete(name);
        delete activity[name];
      }

      // 5. Save updated activity map
      localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
      
    } catch (e) {
      console.error("[EmbeddingCache] Pruning failed:", e);
    }
  }

  /**
   * Clears all embedding caches.
   */
  public static async clearCache(): Promise<void> {
    try {
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        if (name.startsWith(this.CACHE_PREFIX) || name.includes('repo-prompt-embeddings')) {
          await caches.delete(name);
        }
      }
      console.log("[EmbeddingCache] All caches cleared.");
    } catch (e) {
      console.error("[EmbeddingCache] Failed to clear cache:", e);
    }
  }
}
