import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

export function buildPromptText(
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: {name: string, content: string}[]
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
  prompt += `README:\n${repoData.readme.substring(0, 2000)}\n\n`;
  prompt += `Dependencies:\n${repoData.dependencies.substring(0, 2000)}\n`;
  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    prompt += `\nKey Source Files:\n${repoData.sourceFiles.map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}\n`).join('\n')}`;
  }

  if (referenceRepoData) {
    prompt += `\n\n--- REFERENCE REPOSITORY CONTEXT (READ-ONLY) ---\n`;
    prompt += `Repository Name: ${referenceRepoData.info.owner}/${referenceRepoData.info.repo}\n`;
    if (referenceRepoData.info.branch) {
      prompt += `Branch: ${referenceRepoData.info.branch}\n`;
    }
    prompt += `Description: ${referenceRepoData.info.description}\n\n`;
    prompt += `File Tree (partial):\n${referenceRepoData.tree.slice(0, 500).join('\n')}\n\n`;
    prompt += `README:\n${referenceRepoData.readme.substring(0, 2000)}\n\n`;
    prompt += `Dependencies:\n${referenceRepoData.dependencies.substring(0, 2000)}\n`;
    if (referenceRepoData.sourceFiles && referenceRepoData.sourceFiles.length > 0) {
      prompt += `\nKey Source Files:\n${referenceRepoData.sourceFiles.map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}\n`).join('\n')}`;
    }
  }
  prompt += `\n</CODEBASE>\n\n`;

  prompt += `<FINAL_TASK>\n`;
  if (additionalContext && additionalContext.trim()) {
    prompt += `${additionalContext.trim()}\n\n`;
  }
  if (analyzeIssues) {
    prompt += `CRITICAL INSTRUCTION: Perform a preliminary analysis of the provided repository data. Identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Include these findings directly in the generated output.\n\n`;
  }
  prompt += `CRITICAL REMINDER: Execute the instructions defined in <SYSTEM_TEMPLATE> and <FINAL_TASK> using the provided codebase and external documents. Do not lose focus on the primary objective.\n`;
  prompt += `</FINAL_TASK>\n`;

  return prompt;
}

export async function rewriteQueryWithGemini(query: string): Promise<{optimizedQuery: string, intent: string}> {
  if (!query || query.trim() === '') return { optimizedQuery: query, intent: 'GENERAL' };
  
  const prompt = `You are an AI assistant optimizing a search query for a Retrieval-Augmented Generation (RAG) system operating on a code repository.
The user's original query is: "${query}"

Your task is to:
1. Expand this query into 10-15 specific retrieval keywords.
2. Classify the intent (BUG_HUNT, ARCHITECTURE, UI_UX, DATA, GENERAL).

STRICT KEYWORD RULES:
- MUST: Use concrete technical nouns, API names, function signatures, or file paths.
- MUST: Each keyword = ONE technical concept only.
- MUST NOT: Use abstract themes (e.g., "cleaner code", "better performance").
- MUST NOT: Use narrative/summary style keywords.

Return ONLY a valid JSON object with the following structure, nothing else. Do not use markdown formatting blocks like \`\`\`json.
{
  "optimizedQuery": "keyword1, keyword2, keyword3...",
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
  attachedDocs?: {name: string, content: string}[]
): Promise<{ text: string, modelVersion: string }> {
  const prompt = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs);

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
