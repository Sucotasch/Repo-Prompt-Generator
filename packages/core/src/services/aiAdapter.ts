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
  },
): Promise<{
  optimizedQuery: string;
  intent: string;
}> {
  if (
    provider === "custom" &&
    options?.customBaseUrl &&
    options?.customApiKey &&
    options?.customModel
  ) {
    return await rewriteQueryWithOpenAICompatible(
      query,
      options.customBaseUrl,
      options.customApiKey,
      options.customModel,
    );
  } else {
    // Default to Gemini
    return await rewriteQueryWithGemini(
      query,
      options?.geminiApiKey,
      options?.proxyAddress,
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
    proxyAddress?: string;
    fileTruncationLimit?: number;
    isDeepAnalysis?: boolean;
    onStatusUpdate?: (status: string) => void;
    localFiles?: FileList | null;
    referenceLocalFiles?: FileList | null;
  },
): Promise<{
  text: string;
  modelVersion: string;
  requestedFiles?: string[];
  fetchedFilesCount?: number;
  fetchedFilesDetails?: any[];
}> {
  const fileTruncationLimit = options?.fileTruncationLimit ?? 0;

  if (
    provider === "custom" &&
    options?.customBaseUrl &&
    options?.customApiKey &&
    options?.customModel
  ) {
    const promptText = buildPromptText(
      repoData,
      taskInstruction,
      additionalContext,
      analyzeIssues,
      referenceRepoData,
      attachedDocs,
      0,
    );
    const text = await generate_final_prompt_with_openai_compatible(
      promptText,
      options.customBaseUrl,
      options.customApiKey,
      options.customModel,
    );
    return { text, modelVersion: `custom/${options.customModel}` };
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
      options?.referenceLocalFiles
    );
  }
}
