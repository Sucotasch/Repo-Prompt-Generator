import { RepoData } from "./githubService";
import { generateSystemPrompt as geminiGenerate, rewriteQueryWithGemini } from "./geminiService";
import { generateSystemPromptWithQwen, rewriteQueryWithQwen } from "./qwenService";
import { generate_final_prompt_with_ollama, rewriteQueryWithOllama } from "./ollamaService";
import { buildPromptText } from "./geminiService";
import { generate_final_prompt_with_openai_compatible, rewriteQueryWithOpenAICompatible } from "./openaiCompatibleService";

export type AIProvider = 'gemini' | 'qwen' | 'ollama' | 'custom';

export async function rewriteQuery(
  provider: AIProvider,
  query: string,
  options?: {
    qwenToken?: string;
    qwenResourceUrl?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    customBaseUrl?: string;
    customApiKey?: string;
    customModel?: string;
    geminiApiKey?: string;
  }
): Promise<{optimizedQuery: string, intent: string, rateLimit?: { remainingRequests: string, resetRequests: string, remainingTokens: string, resetTokens: string }}> {
  if (provider === 'qwen' && options?.qwenToken) {
    return await rewriteQueryWithQwen(query, options.qwenToken, options.qwenResourceUrl);
  } else if (provider === 'ollama' && options?.ollamaUrl && options?.ollamaModel) {
    return await rewriteQueryWithOllama(query, options.ollamaUrl, options.ollamaModel);
  } else if (provider === 'custom' && options?.customBaseUrl && options?.customApiKey && options?.customModel) {
    return await rewriteQueryWithOpenAICompatible(query, options.customBaseUrl, options.customApiKey, options.customModel);
  } else {
    // Default to Gemini
    return await rewriteQueryWithGemini(query, options?.geminiApiKey);
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
    customBaseUrl?: string;
    customApiKey?: string;
    customModel?: string;
    fileTruncationLimit?: number;
    geminiApiKey?: string;
  }
): Promise<{ text: string, modelVersion: string, rateLimit?: { remainingRequests: string, resetRequests: string, remainingTokens: string, resetTokens: string } }> {
  if (provider === 'qwen' && options?.qwenToken) {
    return await generateSystemPromptWithQwen(
      repoData, taskInstruction, options.qwenToken, additionalContext, analyzeIssues, usedOllama, referenceRepoData, attachedDocs, options.qwenResourceUrl, options.fileTruncationLimit
    );
  } else if (provider === 'ollama' && options?.ollamaUrl && options?.ollamaModel) {
    const promptText = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs, options.fileTruncationLimit);
    const text = await generate_final_prompt_with_ollama(promptText, options.ollamaUrl, options.ollamaModel);
    return { text, modelVersion: `ollama/${options.ollamaModel}` };
  } else if (provider === 'custom' && options?.customBaseUrl && options?.customApiKey && options?.customModel) {
    const promptText = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs, options.fileTruncationLimit);
    const text = await generate_final_prompt_with_openai_compatible(promptText, options.customBaseUrl, options.customApiKey, options.customModel);
    return { text, modelVersion: `custom/${options.customModel}` };
  } else {
    // Default to Gemini
    return await geminiGenerate(
      repoData, taskInstruction, additionalContext, analyzeIssues, usedOllama, referenceRepoData, attachedDocs, options?.fileTruncationLimit, options?.geminiApiKey
    );
  }
}
