export interface RagChunk {
  path: string;
  content: string;
  score?: number;
}

export async function getEmbedding(text: string, ollamaUrl: string, model: string): Promise<number[]> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke('ollama_embed', {
        url: ollamaUrl,
        model,
        prompt: text
      });
    } catch (e: any) {
      throw new Error(`Embedding failed: ${e.message || e}`);
    }
  }

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
  ollamaUrl: string,
  model: string,
  topK: number = 10,
  onProgress?: (msg: string) => void
): Promise<{ path: string, content: string }[]> {

  onProgress?.('Generating embedding for your query...');
  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(query, ollamaUrl, model);
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

  onProgress?.('Calculating semantic similarity...');
  const scoredChunks = allChunks
    .filter(c => c.embedding)
    .map(c => ({
      ...c,
      score: cosineSimilarity(queryEmbedding, c.embedding!)
    }))
    .sort((a, b) => b.score - a.score);

  return scoredChunks.slice(0, topK).map(c => ({
    path: c.path,
    content: `// RAG Semantic Similarity Score: ${(c.score * 100).toFixed(1)}%\n${c.content}`
  }));
}
