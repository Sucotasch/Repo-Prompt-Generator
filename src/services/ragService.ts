import { tauriFetch } from '../utils/tauriFetch';

export interface RagChunk {
  path: string;
  content: string;
  score?: number;
}

export async function getEmbedding(text: string, ollamaUrl: string, model: string): Promise<number[]> {
  const res = await tauriFetch(`${ollamaUrl.replace(/\/$/, '')}/api/embeddings`, {
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
    // split it by spaces to avoid breaking words.
    const MAX_CHARS = 8000;
    if (chunk.length > MAX_CHARS) {
      let currentIdx = 0;
      while (currentIdx < chunk.length) {
        let endIdx = currentIdx + MAX_CHARS;
        if (endIdx < chunk.length) {
          const spaceIdx = chunk.lastIndexOf(' ', endIdx);
          if (spaceIdx > currentIdx + (MAX_CHARS / 2)) {
            endIdx = spaceIdx;
          }
        }
        chunks.push(chunk.substring(currentIdx, endIdx));
        currentIdx = endIdx + (chunk[endIdx] === ' ' ? 1 : 0);
      }
    } else {
      chunks.push(chunk);
    }
    
    if (i + linesPerChunk >= lines.length) break;
  }
  return chunks;
}

export async function performRAG(
  sourceFiles: {path: string, content: string}[],
  query: string,
  intent: string,
  ollamaUrl: string,
  model: string,
  topK: number = 10,
  onProgress?: (msg: string) => void
): Promise<{path: string, content: string}[]> {
  
  const RAG_SYSTEM_INSTRUCTION = `
Analyze the provided code snippets. When determining relevance:
1. Focus on "Concrete Identifiers" (Variable names, Exported Classes, Route Definitions).
2. Avoid "Abstract Sentiment" (The logic 'feels' like it's for security).
3. Prioritize files containing the specific "Retrieval Keywords" provided in the query.
`;

  const queries = query.split('|').map(q => q.trim()).filter(q => q.length > 0);
  if (queries.length === 0) queries.push(query);

  const queryEmbeddings: number[][] = [];
  for (let i = 0; i < queries.length; i++) {
    onProgress?.(`Generating embedding for query ${i + 1}/${queries.length}...`);
    try {
      queryEmbeddings.push(await getEmbedding(queries[i] + "\n" + RAG_SYSTEM_INSTRUCTION, ollamaUrl, model));
    } catch (e: any) {
      throw new Error(`Failed to embed query. Make sure you have pulled the model (e.g., 'ollama pull ${model}'). Details: ${e.message}`);
    }
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
  
  // Extract keywords for lexical boost (hybrid search)
  const keywords = query.toLowerCase().match(/\b\w{3,}\b/g) || [];
  const uniqueKeywords = [...new Set(keywords)];

  const scoredChunks = allChunks
    .filter(c => c.embedding)
    .map(c => {
      let maxSemanticScore = 0;
      for (const qe of queryEmbeddings) {
        const score = cosineSimilarity(qe, c.embedding!);
        if (score > maxSemanticScore) maxSemanticScore = score;
      }
      let score = maxSemanticScore;
      
      // Lexical Boost (Hybrid Search)
      let lexicalBoost = 0;
      for (const kw of uniqueKeywords) {
        // Use word boundary regex for exact matches
        const regex = new RegExp(`\\b${kw}\\b`, 'gi');
        const matches = c.content.match(regex);
        if (matches) {
          lexicalBoost += Math.min(matches.length * 0.02, 0.1);
        }
      }
      score += lexicalBoost;
      
      // Intent-Aware Reranking Multipliers
      const pathLower = c.path.toLowerCase();
      const contentLower = c.content.toLowerCase();
      
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

  const topChunks = scoredChunks.slice(0, topK);
  
  // Group by original file path
  const groupedChunks = new Map<string, { content: string, partIndex: number, score: number }[]>();
  
  for (const c of topChunks) {
    const match = c.path.match(/^(.*) \(Part (\d+)\)$/);
    const originalPath = match ? match[1] : c.path;
    const partIndex = match ? parseInt(match[2], 10) : 0;
    
    if (!groupedChunks.has(originalPath)) {
      groupedChunks.set(originalPath, []);
    }
    groupedChunks.get(originalPath)!.push({ content: c.content, partIndex, score: c.score });
  }
  
  const mergedFiles: {path: string, content: string}[] = [];
  
  for (const [path, chunks] of groupedChunks.entries()) {
    // Sort chunks by their original order in the file
    chunks.sort((a, b) => a.partIndex - b.partIndex);
    
    const maxScore = Math.max(...chunks.map(c => c.score));
    let mergedContent = `// RAG Semantic Similarity Score: ${(maxScore * 100).toFixed(1)}% (Intent: ${intent})\n`;
    
    for (let i = 0; i < chunks.length; i++) {
      mergedContent += chunks[i].content;
      if (i < chunks.length - 1) {
        if (chunks[i+1].partIndex > chunks[i].partIndex + 1) {
          mergedContent += `\n\n... (code omitted) ...\n\n`;
        } else {
          mergedContent += `\n`;
        }
      }
    }
    
    mergedFiles.push({ path, content: mergedContent });
  }

  return mergedFiles;
}
