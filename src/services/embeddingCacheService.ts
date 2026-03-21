/**
 * EmbeddingCacheService
 * 
 * Provides persistent caching of embeddings using the browser's Cache API.
 * This significantly reduces the number of API calls to Ollama/Gemini
 * for repeated queries on the same codebase.
 */
export class EmbeddingCacheService {
  private static CACHE_NAME = 'repo-prompt-embeddings-v2';

  /**
   * Generates a SHA-256 hash for a given text chunk and model.
   * We include the model name in the hash because different models
   * produce incompatible embedding vectors.
   */
  private static async generateHash(text: string, model: string): Promise<string> {
    const data = `${model}:${text}`;
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Retrieves an embedding from the local Cache API.
   */
  public static async getEmbedding(text: string, model: string): Promise<number[] | null> {
    try {
      const hash = await this.generateHash(text, model);
      const cache = await caches.open(this.CACHE_NAME);
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
   * Saves an embedding to the local Cache API.
   */
  public static async saveEmbedding(text: string, model: string, embedding: number[]): Promise<void> {
    try {
      const hash = await this.generateHash(text, model);
      const cache = await caches.open(this.CACHE_NAME);
      const response = new Response(JSON.stringify({ embedding }), {
        headers: { 'Content-Type': 'application/json' }
      });
      await cache.put(`/${hash}`, response);
    } catch (e) {
      console.warn("[EmbeddingCache] Write failed:", e);
    }
  }

  /**
   * Clears the entire embedding cache.
   */
  public static async clearCache(): Promise<void> {
    try {
      await caches.delete(this.CACHE_NAME);
      console.log("[EmbeddingCache] Cache cleared successfully.");
    } catch (e) {
      console.error("[EmbeddingCache] Failed to clear cache:", e);
    }
  }
}
