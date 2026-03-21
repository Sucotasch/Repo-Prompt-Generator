import { EmbeddingCacheService } from './embeddingCacheService';
import { BM25, reciprocalRankFusion } from '../utils/hybridSearch';

export interface RagChunk {
  path: string;
  content: string;
  score?: number;
}

/**
 * Fetches an embedding for a piece of text from Ollama.
 * Uses local caching to avoid redundant API calls.
 */
export async function getEmbedding(text: string, ollamaUrl: string, model: string, repoUrl: string): Promise<number[]> {
  // Try to get from cache first
  const cached = await EmbeddingCacheService.getEmbedding(text, model, repoUrl);
  if (cached) return cached;

  const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const embedding = data.embedding;

  // Save to cache
  await EmbeddingCacheService.saveEmbedding(text, model, embedding, repoUrl);

  return embedding;
}

/**
 * Calculates cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Splits text into chunks for RAG.
 */
function chunkText(text: string, linesPerChunk: number = 30): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  // Overlapping chunks by 5 lines to preserve context across boundaries
  const overlap = 5;
  const step = linesPerChunk - overlap;

  for (let i = 0; i < lines.length; i += step) {
    let chunk = lines.slice(i, i + linesPerChunk).join('\n');

    // Fallback: If a chunk is insanely large (e.g., minified code or base64 on a single line),
    // force-split it by character length to prevent Ollama 500 errors.
    const MAX_CHARS = 8000;
    if (chunk.length > MAX_CHARS) {
      for (let j = 0; j < chunk.length; j += MAX_CHARS) {
        chunks.push(chunk.substring(j, j + MAX_CHARS));
      }
    } else {
      chunks.push(chunk);
    }

    if (i + linesPerChunk >= lines.length) break;
  }
  return chunks;
}

/**
 * Performs RAG on a set of source files.
 * Uses Hybrid Search (BM25 + Vector) and Embedding Caching.
 */
export async function performRAG(
  sourceFiles: { path: string, content: string }[],
  query: string,
  intent: string,
  ollamaUrl: string,
  model: string,
  repoUrl: string,
  topK: number = 10,
  searchStrategy: number = 0.5, // 0 = Pure Vector, 1 = Pure BM25
  onProgress?: (msg: string) => void
): Promise<{ path: string, content: string }[]> {
  
  const RAG_SYSTEM_INSTRUCTION = `
Analyze the provided code snippets. When determining relevance:
1. Focus on "Concrete Identifiers" (Variable names, Exported Classes, Route Definitions).
2. Avoid "Abstract Sentiment" (The logic 'feels' like it's for security).
3. Prioritize files containing the specific "Retrieval Keywords" provided in the query.
`;

  onProgress?.('Generating query embedding...');
  let queryEmbedding: number[];
  try {
    // We don't cache the query embedding as it's dynamic and small
    queryEmbedding = await getEmbedding(query + "\n" + RAG_SYSTEM_INSTRUCTION, ollamaUrl, model, repoUrl);
  } catch (e: any) {
    throw new Error(`Failed to embed query. Details: ${e.message}`);
  }

  const allChunks: { path: string, content: string, embedding?: number[] }[] = [];

  for (const file of sourceFiles) {
    const chunks = chunkText(file.content, 30);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        path: `${file.path} (Part ${i + 1})`,
        content: chunks[i]
      });
    }
  }

  if (allChunks.length === 0) return [];

  // 1. BM25 Lexical Search
  onProgress?.('Indexing for keyword search...');
  const bm25 = new BM25(allChunks.map(c => c.content));
  const bm25Scores = bm25.score(query);

  // 2. Vector Semantic Search
  let processed = 0;
  for (const chunk of allChunks) {
    processed++;
    if (processed % 10 === 0 || processed === 1) {
      onProgress?.(`Embedding code chunks... (${processed}/${allChunks.length})`);
    }
    try {
      chunk.embedding = await getEmbedding(chunk.content, ollamaUrl, model, repoUrl);
    } catch (e) {
      console.warn(`Failed to embed chunk from ${chunk.path}`, e);
    }
  }

  onProgress?.('Calculating hybrid scores and reranking...');
  
  // Calculate raw scores for both methods
  const chunkScores = allChunks.map((chunk, index) => {
    let semanticScore = chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
    
    // Apply Intent-Aware Reranking Multipliers to Semantic Score
    const pathLower = chunk.path.toLowerCase();
    const contentLower = chunk.content.toLowerCase();
    
    if (intent === 'BUG_HUNT') {
      if (pathLower.includes('.test.') || pathLower.includes('.spec.')) semanticScore *= 1.1;
      if (contentLower.includes('error') || contentLower.includes('catch') || contentLower.includes('throw')) semanticScore *= 1.1;
    } else if (intent === 'ARCHITECTURE') {
      if (pathLower.endsWith('.md') || pathLower.includes('docs/')) semanticScore *= 1.2;
      if (pathLower.includes('types') || pathLower.includes('interfaces')) semanticScore *= 1.1;
      if (pathLower.includes('index.') || pathLower.includes('main.') || pathLower.includes('app.')) semanticScore *= 1.1;
    } else if (intent === 'UI_UX') {
      if (pathLower.endsWith('.tsx') || pathLower.endsWith('.jsx') || pathLower.endsWith('.css') || pathLower.endsWith('.scss')) semanticScore *= 1.2;
      if (pathLower.includes('components/') || pathLower.includes('views/') || pathLower.includes('pages/')) semanticScore *= 1.1;
    } else if (intent === 'DATA') {
      if (pathLower.endsWith('.sql') || pathLower.includes('db/') || pathLower.includes('models/')) semanticScore *= 1.2;
      if (pathLower.includes('services/') || pathLower.includes('store/') || pathLower.includes('api/')) semanticScore *= 1.1;
    }

    return {
      chunk,
      semanticScore,
      lexicalScore: bm25Scores[index]
    };
  });

  // 3. Rank results for both methods
  const vectorRanked = [...chunkScores]
    .sort((a, b) => b.semanticScore - a.semanticScore)
    .map(s => s.chunk);
    
  const lexicalRanked = [...chunkScores]
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .map(s => s.chunk);

  // 4. Reciprocal Rank Fusion
  // searchStrategy: 0 = Pure Vector, 1 = Pure BM25
  const vectorWeight = 1 - searchStrategy;
  const lexicalWeight = searchStrategy;
  
  const fusedResults = reciprocalRankFusion(
    vectorRanked, 
    lexicalRanked, 
    vectorWeight, 
    lexicalWeight
  );

  // 5. Return top K
  return fusedResults.slice(0, topK).map(r => ({
    path: r.item.path,
    content: `// RAG Hybrid Rank Score: ${(r.score * 100).toFixed(4)} (Strategy: ${searchStrategy}, Intent: ${intent})\n${r.item.content}`
  }));
}
