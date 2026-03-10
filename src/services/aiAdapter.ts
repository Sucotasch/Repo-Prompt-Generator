import { RepoData } from "./githubService";
import { generateSystemPrompt as geminiGenerate, rewriteQueryWithGemini } from "./geminiService";
import { generateSystemPromptWithQwen, rewriteQueryWithQwen } from "./qwenService";
import { generate_final_prompt_with_ollama, rewriteQueryWithOllama } from "./ollamaService";
import { buildPromptText } from "./geminiService";

export type AIProvider = 'gemini' | 'qwen' | 'ollama';

export async function rewriteQuery(
  provider: AIProvider,
  query: string,
  options?: {
    qwenToken?: string;
    qwenResourceUrl?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  }
): Promise<{optimizedQuery: string, intent: string}> {
  if (provider === 'qwen' && options?.qwenToken) {
    return await rewriteQueryWithQwen(query, options.qwenToken, options.qwenResourceUrl);
  } else if (provider === 'ollama' && options?.ollamaUrl && options?.ollamaModel) {
    return await rewriteQueryWithOllama(query, options.ollamaUrl, options.ollamaModel);
  } else {
    // Default to Gemini
    return await rewriteQueryWithGemini(query);
  }
}

export async function generatePrompt(
  provider: AIProvider,
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean, 
  usedOllama?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: {name: string, content: string}[],
  options?: {
    qwenToken?: string;
    qwenResourceUrl?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  }
): Promise<{ text: string, modelVersion: string }> {
  if (provider === 'qwen' && options?.qwenToken) {
    return await generateSystemPromptWithQwen(
      repoData, taskInstruction, options.qwenToken, additionalContext, analyzeIssues, usedOllama, referenceRepoData, attachedDocs, options.qwenResourceUrl
    );
  } else if (provider === 'ollama' && options?.ollamaUrl && options?.ollamaModel) {
    const promptText = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs);
    const text = await generate_final_prompt_with_ollama(promptText, options.ollamaUrl, options.ollamaModel);
    return { text, modelVersion: `ollama/${options.ollamaModel}` };
  } else {
    // Default to Gemini
    return await geminiGenerate(
      repoData, taskInstruction, additionalContext, analyzeIssues, usedOllama, referenceRepoData, attachedDocs
    );
  }
}
