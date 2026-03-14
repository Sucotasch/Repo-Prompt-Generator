import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

export function buildPromptText(
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: {name: string, content: string}[],
  fileTruncationLimit?: number
): string {
  let prompt = `<SYSTEM_TEMPLATE>\n${taskInstruction}\n</SYSTEM_TEMPLATE>\n\n`;

  if (attachedDocs && attachedDocs.length > 0) {
    prompt += `<EXTERNAL_DOCUMENTS>\n`;
    attachedDocs.forEach(doc => {
      prompt += `--- Document: ${doc.name} ---\n${doc.content}\n\n`;
    });
    prompt += `</EXTERNAL_DOCUMENTS>\n\n`;
  }

  prompt += `<CODEBASE>\n`;
  prompt += `--- TARGET REPOSITORY CONTEXT ---\n`;
  prompt += `Repository Name: ${repoData.info.owner}/${repoData.info.repo}\n`;
  if (repoData.info.branch) {
    prompt += `Branch: ${repoData.info.branch}\n`;
  }
  prompt += `Description: ${repoData.info.description}\n\n`;
  prompt += `File Tree (partial):\n${repoData.tree.slice(0, 500).join('\n')}\n\n`;
  prompt += `README:\n${fileTruncationLimit && fileTruncationLimit > 0 ? repoData.readme.substring(0, fileTruncationLimit) : repoData.readme}\n\n`;
  prompt += `Dependencies:\n${fileTruncationLimit && fileTruncationLimit > 0 ? repoData.dependencies.substring(0, fileTruncationLimit) : repoData.dependencies}\n`;
  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    prompt += `\nKey Source Files:\n${repoData.sourceFiles.map(f => `--- ${f.path} ---\n${fileTruncationLimit && fileTruncationLimit > 0 ? f.content.substring(0, fileTruncationLimit) : f.content}\n`).join('\n')}`;
  }

  if (referenceRepoData) {
    prompt += `\n\n--- REFERENCE REPOSITORY CONTEXT (READ-ONLY) ---\n`;
    prompt += `Repository Name: ${referenceRepoData.info.owner}/${referenceRepoData.info.repo}\n`;
    if (referenceRepoData.info.branch) {
      prompt += `Branch: ${referenceRepoData.info.branch}\n`;
    }
    prompt += `Description: ${referenceRepoData.info.description}\n\n`;
    prompt += `File Tree (partial):\n${referenceRepoData.tree.slice(0, 500).join('\n')}\n\n`;
    prompt += `README:\n${fileTruncationLimit && fileTruncationLimit > 0 ? referenceRepoData.readme.substring(0, fileTruncationLimit) : referenceRepoData.readme}\n\n`;
    prompt += `Dependencies:\n${fileTruncationLimit && fileTruncationLimit > 0 ? referenceRepoData.dependencies.substring(0, fileTruncationLimit) : referenceRepoData.dependencies}\n`;
    if (referenceRepoData.sourceFiles && referenceRepoData.sourceFiles.length > 0) {
      prompt += `\nKey Source Files:\n${referenceRepoData.sourceFiles.map(f => `--- ${f.path} ---\n${fileTruncationLimit && fileTruncationLimit > 0 ? f.content.substring(0, fileTruncationLimit) : f.content}\n`).join('\n')}`;
    }
  }
  prompt += `\n</CODEBASE>\n\n`;

  prompt += `<FINAL_TASK>\n`;
  prompt += `CRITICAL INSTRUCTION: You must now execute the following task based on the codebase provided above:\n`;
  prompt += `--- TASK START ---\n${taskInstruction}\n--- TASK END ---\n\n`;
  
  if (additionalContext && additionalContext.trim()) {
    prompt += `Additional Context/Instructions:\n${additionalContext.trim()}\n\n`;
  }
  if (analyzeIssues) {
    prompt += `CRITICAL INSTRUCTION: Perform a preliminary analysis of the provided repository data. Identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Include these findings directly in the generated output.\n\n`;
  }
  prompt += `</FINAL_TASK>\n`;

  return prompt;
}

export async function rewriteQueryWithGemini(query: string): Promise<{optimizedQuery: string, intent: string}> {
  if (!query || query.trim() === '') return { optimizedQuery: query, intent: 'GENERAL' };
  
  const prompt = `You are an AI assistant optimizing a search query for a Retrieval-Augmented Generation (RAG) system operating on a code repository.
The user's original query is: "${query}"

Your task is to:
1. Extract MULTIPLE concrete technical search queries that would find relevant code.
2. Generate exactly 3 distinct queries covering different aspects of the request (e.g., one for architecture, one for dependencies, one for specific APIs).
3. Classify the intent (BUG_HUNT, ARCHITECTURE, UI_UX, DATA, GENERAL).

STRICT KEYWORD RULES:
- MUST: Use concrete technical nouns, API names, function signatures, or file paths.
- MUST: If the user query is in another language, translate the search keywords to English to match the codebase.
- MUST: Separate the 3 queries using the pipe character (|).
- MUST NOT: Use abstract themes (e.g., "cleaner code", "better performance").

Return ONLY a valid JSON object with the following structure, nothing else. Do not use markdown formatting blocks like \`\`\`json.
{
  "optimizedQuery": "query 1 keywords | query 2 keywords | query 3 keywords",
  "intent": "CATEGORY_NAME"
}`;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });
    
    const text = response.text?.trim() || '{}';
    const parsed = JSON.parse(text);
    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || 'GENERAL'
    };
  } catch (e) {
    console.error("Failed to rewrite query with Gemini:", e);
    return { optimizedQuery: query, intent: 'GENERAL' };
  }
}

export async function generateSystemPrompt(
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean, 
  usedOllama?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: {name: string, content: string}[],
  fileTruncationLimit?: number
): Promise<{ text: string, modelVersion: string }> {
  const prompt = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs, fileTruncationLimit);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  let finalPrompt = response.text || "Failed to generate prompt.";

  // Extract model version from response if available, otherwise fallback to the requested model
  const modelVersion = (response as any).modelVersion || (response as any).model || "gemini-3-flash-preview";

  return { text: finalPrompt, modelVersion };
}
