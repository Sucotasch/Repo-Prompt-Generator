import { RepoData } from "./githubService";
import {
  generateSystemPrompt as geminiGenerate,
  rewriteQueryWithGemini,
} from "./geminiService";
import { buildPromptText } from "./geminiService";
import {
  generate_final_prompt_with_openai_compatible,
  rewriteQueryWithOpenAICompatible,
} from "./openaiCompatibleService";

export type AIProvider = "gemini" | "custom";

export async function rewriteQuery(
  provider: AIProvider,
  query: string,
  options?: {
    ollamaUrl?: string;
    ollamaModel?: string;
    customBaseUrl?: string;
    customApiKey?: string;
    customModel?: string;
    geminiApiKey?: string;
    proxyAddress?: string;
    signal?: AbortSignal;
  },
): Promise<{
  optimizedQuery: string;
  intent: string;
  isFallback?: boolean;
}> {
  if (provider === "custom") {
    const baseUrl = options?.customBaseUrl?.trim();
    const model = options?.customModel?.trim();
    if (!baseUrl) {
      throw new Error("Custom Provider is selected, but Base URL is missing.");
    }
    if (!model) {
      throw new Error("Custom Provider is selected, but Model Name is missing.");
    }
    return await rewriteQueryWithOpenAICompatible(
      query,
      baseUrl,
      options?.customApiKey?.trim() || "",
      model,
      options?.signal,
    );
  } else {
    // Default to Gemini
    return await rewriteQueryWithGemini(
      query,
      options?.geminiApiKey,
      options?.proxyAddress,
      options?.signal,
    );
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
  attachedDocs?: { name: string; content: string }[],
  options?: {
    ollamaUrl?: string;
    ollamaModel?: string;
    customBaseUrl?: string;
    customApiKey?: string;
    customModel?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    geminiThinkingLevel?: string;
    proxyAddress?: string;
    fileTruncationLimit?: number;
    isDeepAnalysis?: boolean;
    onStatusUpdate?: (status: string) => void;
    localFiles?: FileList | null;
    referenceLocalFiles?: FileList | null;
    githubToken?: string;
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<{
  text: string;
  modelVersion: string;
  requestedFiles?: string[];
  fetchedFilesCount?: number;
  grepQueries?: string[];
}> {
  const fileTruncationLimit = options?.fileTruncationLimit ?? 0;

  if (provider === "custom") {
    const baseUrl = options?.customBaseUrl?.trim();
    const model = options?.customModel?.trim();
    if (!baseUrl) {
      throw new Error("Custom Provider is selected, but Base URL is missing.");
    }
    if (!model) {
      throw new Error("Custom Provider is selected, but Model Name is missing.");
    }
    const promptText = buildPromptText(
      repoData,
      taskInstruction,
      additionalContext,
      analyzeIssues,
      referenceRepoData,
      attachedDocs,
      fileTruncationLimit,
    );
    const text = await generate_final_prompt_with_openai_compatible(
      promptText,
      baseUrl,
      options?.customApiKey?.trim() || "",
      model,
      options?.temperature ?? 0.3,
      options?.signal,
    );
    return { text, modelVersion: `custom/${model}` };
  } else {
    // Default to Gemini
    return await geminiGenerate(
      repoData,
      taskInstruction,
      options?.geminiApiKey || "",
      options?.proxyAddress || "",
      additionalContext,
      analyzeIssues,
      usedOllama,
      referenceRepoData,
      attachedDocs,
      fileTruncationLimit,
      options?.isDeepAnalysis,
      options?.onStatusUpdate,
      options?.localFiles,
      options?.referenceLocalFiles,
      options?.githubToken,
      options?.signal,
      options?.geminiModel,
      options?.geminiThinkingLevel,
    );
  }
}
