export interface RagChunk {
  path: string;
  content: string;
  score?: number;
}

export async function getEmbedding(text: string, ollamaUrl: string, model: string): Promise<number[]> {
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
  return data.embedding;
}

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
    // We use a very safe limit of 8000 characters (approx 2000 tokens) to accommodate 
    // embedding models with smaller context windows (e.g. 2048 tokens).
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

export async function performRAG(
  sourceFiles: { path: string, content: string }[],
  query: string,
  intent: string,
  ollamaUrl: string,
  model: string,
  topK: number = 10,
  onProgress?: (msg: string) => void
): Promise<{ path: string, content: string }[]> {
  
  const RAG_SYSTEM_INSTRUCTION = `
Analyze the provided code snippets. When determining relevance:
1. Focus on "Concrete Identifiers" (Variable names, Exported Classes, Route Definitions).
2. Avoid "Abstract Sentiment" (The logic 'feels' like it's for security).
3. Prioritize files containing the specific "Retrieval Keywords" provided in the query.
`;

  onProgress?.('Generating embedding for your query...');
  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(query + "\n" + RAG_SYSTEM_INSTRUCTION, ollamaUrl, model);
  } catch (e: any) {
    throw new Error(`Failed to embed query. Make sure you have pulled the model (e.g., 'ollama pull ${model}'). Details: ${e.message}`);
  }

  const allChunks: { path: string, content: string, embedding?: number[] }[] = [];

  for (const file of sourceFiles) {
    // 30 lines per chunk is safer for embedding models
    const chunks = chunkText(file.content, 30);
    for (let i = 0; i < chunks.length; i++) {
      allChunks.push({
        path: `${file.path} (Part ${i + 1})`,
        content: chunks[i]
      });
    }
  }

  let processed = 0;
  // Process sequentially to avoid overloading local Ollama instance
  for (const chunk of allChunks) {
    processed++;
    if (processed % 5 === 0 || processed === 1) {
      onProgress?.(`Embedding code chunks... (${processed}/${allChunks.length})`);
    }
    try {
      chunk.embedding = await getEmbedding(chunk.content, ollamaUrl, model);
    } catch (e) {
      console.warn(`Failed to embed chunk from ${chunk.path}`, e);
    }
  }

  onProgress?.('Calculating semantic similarity with intent-aware reranking...');
  
  // Extract simple keywords from the original query to do hybrid lexical boosting
  // We remove common stop words and keep words >= 3 chars
  const stopWords = ['what', 'where', 'when', 'how', 'why', 'who', 'the', 'and', 'for', 'with', 'about', 'this', 'that'];
  const rawKeywords = query.toLowerCase().split(/[\s,.;]+/).filter(w => w.length >= 3 && !stopWords.includes(w));
  // Keep only up to 5 of the most unique/longest words to prevent over-boosting common terms
  const keywords = rawKeywords.sort((a, b) => b.length - a.length).slice(0, 5);

  const scoredChunks = allChunks
    .filter(c => c.embedding)
    .map(c => {
      let score = cosineSimilarity(queryEmbedding, c.embedding!);
      
      const pathLower = c.path.toLowerCase();
      const contentLower = c.content.toLowerCase();

      // Hybrid Lexical Boosting: Check for exact keyword matches
      let keywordMatches = 0;
      for (const kw of keywords) {
        if (contentLower.includes(kw) || pathLower.includes(kw)) {
          keywordMatches++;
        }
      }
      // If a specific keyword is found, significantly boost the semantic score
      // Adding 0.5 absolutely guarantees it outranks generic semantic matches
      if (keywordMatches > 0) {
        score += (0.50 * keywordMatches);
      }

      // Intent-Aware Reranking Multipliers
      if (intent === 'BUG_HUNT') {
        if (pathLower.includes('.test.') || pathLower.includes('.spec.')) score *= 1.1;
        if (contentLower.includes('error') || contentLower.includes('catch') || contentLower.includes('throw')) score *= 1.1;
      } else if (intent === 'ARCHITECTURE') {
        if (pathLower.endsWith('.md') || pathLower.includes('docs/')) score *= 1.2;
        if (pathLower.includes('types') || pathLower.includes('interfaces')) score *= 1.1;
        if (pathLower.includes('index.') || pathLower.includes('main.') || pathLower.includes('app.')) score *= 1.1;
      } else if (intent === 'UI_UX') {
        if (pathLower.endsWith('.tsx') || pathLower.endsWith('.jsx') || pathLower.endsWith('.css') || pathLower.endsWith('.scss')) score *= 1.2;
        if (pathLower.includes('components/') || pathLower.includes('views/') || pathLower.includes('pages/')) score *= 1.1;
      } else if (intent === 'DATA') {
        if (pathLower.endsWith('.sql') || pathLower.includes('db/') || pathLower.includes('models/')) score *= 1.2;
        if (pathLower.includes('services/') || pathLower.includes('store/') || pathLower.includes('api/')) score *= 1.1;
      }
      
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  return scoredChunks.slice(0, topK).map(c => ({
    path: c.path,
    content: `// RAG Semantic Similarity Score: ${(c.score * 100).toFixed(1)}% (Intent: ${intent})\n${c.content}`
  }));
}
