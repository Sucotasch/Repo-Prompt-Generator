import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

export function buildPromptText(
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean
): string {
  return `--- TASK INSTRUCTION ---
${taskInstruction}

--- REPOSITORY CONTEXT ---
Repository Name: ${repoData.info.owner}/${repoData.info.repo}
Description: ${repoData.info.description}

File Tree (partial):
${repoData.tree.slice(0, 500).join('\n')}

README:
${repoData.readme.substring(0, 2000)}

Dependencies:
${repoData.dependencies.substring(0, 2000)}
${repoData.sourceFiles && repoData.sourceFiles.length > 0 ? `\nKey Source Files:\n${repoData.sourceFiles.map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}\n`).join('\n')}` : ''}
${additionalContext ? `\nAdditional Context / Future Development Directions:\n${additionalContext}\n` : ''}${analyzeIssues ? `\nCRITICAL INSTRUCTION: Perform a preliminary analysis of the provided repository data. Identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Include these findings directly in the generated output.\n` : ''}`;
}

export async function rewriteQueryWithGemini(query: string): Promise<{optimizedQuery: string, intent: string}> {
  if (!query || query.trim() === '') return { optimizedQuery: query, intent: 'GENERAL' };
  
  const prompt = `You are an AI assistant optimizing a search query for a Retrieval-Augmented Generation (RAG) system operating on a code repository.
The user's original query is: "${query}"

Your task is to perform two actions:
1. Rewrite and expand this query to improve semantic search results. Include synonyms, related technical terms, and likely variable/function names.
2. Classify the user's intent into one of the following categories:
   - BUG_HUNT: Looking for errors, bugs, infinite loops, crashes, or debugging.
   - ARCHITECTURE: Understanding how things work, structure, flow, or documentation.
   - UI_UX: Looking for frontend components, styles, buttons, views, or user interface.
   - DATA: Database, saving, API calls, state management, or data flow.
   - GENERAL: Default category if none of the above fit perfectly.

Return ONLY a valid JSON object with the following structure, nothing else. Do not use markdown formatting blocks like \`\`\`json.
{
  "optimizedQuery": "expanded query string here",
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
  usedOllama?: boolean
): Promise<{ text: string, modelVersion: string }> {
  const prompt = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  let finalPrompt = response.text || "Failed to generate prompt.";
  if (usedOllama) {
    finalPrompt = `> **Note:** This context was pre-processed by local LLM.\n\n` + finalPrompt;
  }

  // Extract model version from response if available, otherwise fallback to the requested model
  const modelVersion = (response as any).modelVersion || (response as any).model || "gemini-3-flash-preview";

  return { text: finalPrompt, modelVersion };
}
