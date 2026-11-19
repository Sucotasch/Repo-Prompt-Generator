import { EmbeddingCacheService } from "./embeddingCacheService";
import { RepoSourceFile } from "./githubService";
import { BM25, reciprocalRankFusion } from "../utils/hybridSearch";
import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import { stripTrailingTruncationNotice } from "../utils/pathFilters.ts";
import { ChunkResult, SemanticChunker } from "../utils/semanticChunker";

export interface RagChunk {
  path: string;
  content: string;
  score?: number;
}

/**
 * Fetches an embedding for a piece of text from Ollama.
 * Uses local caching to avoid redundant API calls.
 */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function assertValidEmbedding(embedding: unknown, context: string): number[] {
  if (
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    typeof embedding[0] !== "number"
  ) {
    throw new Error(
      `Invalid or empty embedding returned (${context}). Ensure an embedding model is selected.`,
    );
  }
  return embedding as number[];
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Generation cancelled", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Generation cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function getEmbedding(
  text: string,
  ollamaUrl: string,
  model: string,
  repoUrl: string,
  engine: "ollama" | "lmstudio" | "llamacpp" = "ollama",
  signal?: AbortSignal,
): Promise<number[]> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  // Try to get from cache first
  const cached = await EmbeddingCacheService.getEmbedding(text, model, repoUrl);
  if (cached) return cached;

  const cleanUrl = normalizeUrl(ollamaUrl);
  let embedding: number[];

  if (isTauri()) {
    if (engine === "ollama") {
      const raw = await withAbortSignal(
        tauriInvoke<number[]>("ollama_embed", {
          url: cleanUrl,
          model,
          prompt: text,
        }),
        signal,
      );
      embedding = assertValidEmbedding(raw, "Tauri Ollama");
    } else {
      const response = await withAbortSignal(
        tauriInvoke<any>("ai_network_request", {
          method: "POST",
          url: `${cleanUrl}/embeddings`,
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            input: text,
          }),
        }),
        signal,
      );

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`OpenAI API Error: ${response.status} - ${response.text}`);
      }
      const data = JSON.parse(response.text);
      embedding = assertValidEmbedding(data?.data?.[0]?.embedding, "Tauri OpenAI-compatible");
    }
  } else {
    if (engine === "ollama") {
      const res = await fetch(`${cleanUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          prompt: text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Embedding failed (${res.status}): ${errText}`);
      }

      const data = await res.json();
      embedding = assertValidEmbedding(data?.embedding, "Web Ollama");
    } else {
      const res = await fetch(`${cleanUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!res.ok) {
         const errText = await res.text();
         throw new Error(`Embedding failed (${res.status}): ${errText}`);
      }

      const data = await res.json();
      embedding = assertValidEmbedding(data?.data?.[0]?.embedding, "Web OpenAI-compatible");
    }
  }

  // Save to cache
  await EmbeddingCacheService.saveEmbedding(text, model, embedding, repoUrl);

  return embedding;
}

/**
 * Calculates cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Splits text into chunks for RAG.
 * Maps legacy "linesPerChunk" to approximate tokens to preserve backward compatibility.
 */
function chunkText(text: string, filePath: string, linesPerChunk: number = 30): ChunkResult[] {
  // Approximate conversion: 1 line ≈ 15 tokens.
  const maxTokens = linesPerChunk * 15;
  // 10% overlap to preserve context across boundaries
  const overlapTokens = Math.floor(maxTokens * 0.1);
  
  return SemanticChunker.chunkText(text, { maxTokens, overlapTokens, filePath });
}

/**
 * Performs RAG on a set of source files.
 * Uses Hybrid Search (BM25 + Vector) and Embedding Caching.
 */
export async function performRAG(
  sourceFiles: RepoSourceFile[],
  query: string,
  intent: string,
  ollamaUrl: string,
  model: string,
  repoUrl: string,
  topK: number = 10,
  searchStrategy: number = 0.5, // 0 = Pure Vector, 1 = Pure BM25
  chunkSize: number = 30,
  onProgress?: (msg: string) => void,
  engine: "ollama" | "lmstudio" | "llamacpp" = "ollama",
  signal?: AbortSignal,
  onWarning?: (msg: string) => void,
): Promise<RepoSourceFile[]> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }

  onProgress?.("Generating query embedding (loading local model if needed)...");
  let queryEmbedding: number[] | null = null;
  let lastEmbeddingError: string | null = null;
  try {
    // We don't cache the query embedding as it's dynamic and small
    queryEmbedding = await getEmbedding(
      query,
      ollamaUrl,
      model,
      repoUrl,
      engine,
      signal,
    );
  } catch (e: any) {
    if (e?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    lastEmbeddingError = e?.message || String(e);
    const warnMsg = `Vector embedding failed for model '${model}' (${lastEmbeddingError}). Falling back to keyword search (BM25 only).`;
    console.warn(`[RAG Warning] ${warnMsg}`);
    onWarning?.(warnMsg);
  }

  const allChunks: {
    path: string;
    content: string;
    zone: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated?: boolean;
    embedding?: number[];
  }[] = [];

  for (const file of sourceFiles) {
    const cleanText = stripTrailingTruncationNotice(file.content).cleanText;
    const baseStartLine = file.startLine ?? 1;
    const rawLineCount = cleanText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
    const totalLines = file.totalLines ?? (baseStartLine + rawLineCount - 1);
    const chunks = chunkText(cleanText, file.path, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        path: `${file.path} (Part ${i + 1})`,
        content: chunks[i].text,
        zone: chunks[i].zone,
        startLine: baseStartLine + chunks[i].startLine - 1,
        endLine: baseStartLine + chunks[i].endLine - 1,
        totalLines,
        truncated: file.truncated,
      });
    }
  }

  if (allChunks.length === 0) return [];

  // 1. BM25 Lexical Search
  onProgress?.("Indexing for keyword search...");
  const bm25 = new BM25(allChunks.map((c) => c.content));
  const bm25Scores = bm25.score(query);

  // 2. Vector Semantic Search
  let processed = 0;
  let consecutiveFailures = 0;
  if (queryEmbedding) {
    for (const chunk of allChunks) {
      if (signal?.aborted) {
        throw new DOMException("Generation cancelled", "AbortError");
      }
      processed++;
      if (processed % 10 === 0 || processed === 1) {
        onProgress?.(
          `Embedding code chunks... (${processed}/${allChunks.length})`,
        );
      }
      try {
        chunk.embedding = await getEmbedding(
          chunk.content,
          ollamaUrl,
          model,
          repoUrl,
          engine,
          signal,
        );
        consecutiveFailures = 0;
      } catch (e: any) {
        if (e?.name === "AbortError" || signal?.aborted) {
          throw new DOMException("Generation cancelled", "AbortError");
        }
        consecutiveFailures++;
        lastEmbeddingError = e?.message || String(e);
        console.warn(`Failed to embed chunk from ${chunk.path}`, e);
        if (consecutiveFailures >= 3) {
          const abortWarn = `Stopped chunk vector indexing after 3 consecutive failures (${lastEmbeddingError}). Remaining chunks will rely on BM25.`;
          console.warn(`[RAG Warning] ${abortWarn}`);
          onWarning?.(abortWarn);
          break;
        }
      }
    }
  }

  const hasVectorEmbeddings =
    Boolean(queryEmbedding) &&
    allChunks.some((c) => Array.isArray(c.embedding) && c.embedding.length > 0);

  if (queryEmbedding && !hasVectorEmbeddings && lastEmbeddingError) {
    onWarning?.(
      `Chunk embeddings failed for '${model}' (${lastEmbeddingError}). Falling back to keyword search (BM25 only).`,
    );
  }

  onProgress?.(
    hasVectorEmbeddings
      ? "Calculating hybrid scores and reranking..."
      : "Calculating BM25 fallback scores...",
  );

  // Calculate raw scores for both methods
  const chunkScores = allChunks.map((chunk, index) => {
    let semanticScore = (queryEmbedding && chunk.embedding)
      ? cosineSimilarity(queryEmbedding, chunk.embedding)
      : 0;

    // Apply Intent-Aware Reranking Multipliers to Semantic Score
    const pathLower = chunk.path.replace(/\s+\(Part \d+\)$/i, "").toLowerCase();
    const contentLower = chunk.content.toLowerCase();

    if (intent === "BUG_HUNT") {
      if (pathLower.includes(".test.") || pathLower.includes(".spec."))
        semanticScore += 0.1;
      if (
        contentLower.includes("error") ||
        contentLower.includes("catch") ||
        contentLower.includes("throw")
      )
        semanticScore += 0.1;
    } else if (intent === "ARCHITECTURE") {
      if (pathLower.endsWith(".md") || pathLower.endsWith(".mdx") || pathLower.includes("docs/"))
        semanticScore += 0.2;
      if (pathLower.includes("types") || pathLower.includes("interfaces"))
        semanticScore += 0.1;
      if (
        pathLower.includes("index.") ||
        pathLower.includes("main.") ||
        pathLower.includes("app.")
      )
        semanticScore += 0.1;
    } else if (intent === "UI_UX") {
      if (
        pathLower.endsWith(".tsx") ||
        pathLower.endsWith(".jsx") ||
        pathLower.endsWith(".vue") ||
        pathLower.endsWith(".svelte") ||
        pathLower.endsWith(".html") ||
        pathLower.endsWith(".css") ||
        pathLower.endsWith(".scss")
      )
        semanticScore += 0.2;
      if (
        pathLower.includes("components/") ||
        pathLower.includes("views/") ||
        pathLower.includes("pages/")
      )
        semanticScore += 0.1;
    } else if (intent === "DATA") {
      if (
        pathLower.endsWith(".sql") ||
        pathLower.endsWith(".prisma") ||
        pathLower.includes("db/") ||
        pathLower.includes("models/")
      )
        semanticScore += 0.2;
      if (
        pathLower.includes("services/") ||
        pathLower.includes("store/") ||
        pathLower.includes("api/")
      )
        semanticScore += 0.1;
    }

    return {
      chunk,
      semanticScore,
      lexicalScore: bm25Scores[index],
    };
  });

  // 3. Rank results for both methods
  const vectorRanked = [...chunkScores]
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .map((s) => s.chunk);

  const lexicalRanked = [...chunkScores]
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .map((s) => s.chunk);

  // 4. Reciprocal Rank Fusion
  // searchStrategy: 0 = Pure Vector, 1 = Pure BM25
  // If query or all chunk embeddings failed, gracefully fallback to 100% BM25 lexical search
  const vectorWeight = hasVectorEmbeddings ? (1 - searchStrategy) : 0;
  const lexicalWeight = hasVectorEmbeddings ? searchStrategy : 1;

  const fusedResults = reciprocalRankFusion(
    vectorRanked,
    lexicalRanked,
    vectorWeight,
    lexicalWeight,
  );

  // 5. Group by Zone and Return top K
  const topResults = fusedResults.slice(0, topK);
  
  // Group results by zone
  const groupedResults: Record<string, typeof topResults> = {};
  for (const r of topResults) {
    const zone = r.item.zone || "General";
    if (!groupedResults[zone]) {
      groupedResults[zone] = [];
    }
    groupedResults[zone].push(r);
  }

  // Format the output
  const formattedResults: RepoSourceFile[] = [];
  
  for (const [zone, results] of Object.entries(groupedResults)) {
    // Add a zone header as a pseudo-file to structure the prompt (marked as summary so line numbers aren't applied)
    formattedResults.push({
      path: `--- ZONE: ${zone.toUpperCase()} ---`,
      content: `The following files belong to the ${zone} architectural zone.`,
      isSummary: true,
      zone,
    });
    
    for (const r of results) {
      formattedResults.push({
        path: r.item.path,
        content: r.item.content,
        startLine: r.item.startLine,
        endLine: r.item.endLine,
        totalLines: r.item.totalLines,
        truncated: r.item.truncated || r.item.startLine > 1 || r.item.endLine < r.item.totalLines,
        ragScore: Number((r.score * 100).toFixed(2)),
        zone,
      });
    }
  }

  return formattedResults;
}
