import { RepoData } from "./githubService";
import { buildPromptText } from "./geminiService";
import { isTauri } from "../utils/tauriAdapter.ts";
import { invoke } from "@tauri-apps/api/core";

export async function rewriteQueryWithQwen(
  query: string,
  token: string,
  resourceUrl?: string,
): Promise<{
  optimizedQuery: string;
  intent: string;
  rateLimit?: {
    remainingRequests: string;
    resetRequests: string;
    remainingTokens: string;
    resetTokens: string;
  };
}> {
  if (!query?.trim()) return { optimizedQuery: query, intent: "GENERAL" };

  const prompt = `Optimize the search query for RAG over a code repository. Return ONLY JSON:
{"optimizedQuery":"key1,key2...", "intent":"CATEGORY"}
Query: "${query}"`;

  try {
    if (isTauri()) {
      const data = await invoke<any>("qwen_ai_proxy", {
        token,
        prompt,
        model: "coder-model",
        isJson: true,
        resourceUrl,
      });

      if (data.status && data.status >= 400) {
        const err: any = new Error(data.output?.error || "Qwen API Error");
        err.rateLimit = data.rateLimit;
        err.status = data.status;
        throw err;
      }

      const text = data.output?.output?.text || "{}";
      const parsed = JSON.parse(text);
      return {
        optimizedQuery: parsed.optimizedQuery || query,
        intent: parsed.intent || "GENERAL",
        rateLimit: data.rateLimit,
      };
    }

    const response = await fetch("/api/qwen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        resourceUrl,
        prompt,
        model: "coder-model",
        isJson: true,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const err: any = new Error(data.error || "Qwen request failed");
      err.rateLimit = data.rateLimit;
      err.status = response.status;
      throw err;
    }

    const text = data.output?.text || "{}";
    const parsed = JSON.parse(text);
    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
      rateLimit: data.rateLimit,
    };
  } catch (e: any) {
    console.error("Failed to rewrite query with Qwen:", e);
    return { optimizedQuery: query, intent: "GENERAL", rateLimit: e.rateLimit };
  }
}

export async function generateSystemPromptWithQwen(
  repoData: RepoData,
  taskInstruction: string,
  token: string,
  additionalContext?: string,
  analyzeIssues?: boolean,
  usedOllama?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: { name: string; content: string }[],
  resourceUrl?: string,
  fileTruncationLimit: number = 0,
): Promise<{
  text: string;
  modelVersion: string;
  rateLimit?: {
    remainingRequests: string;
    resetRequests: string;
    remainingTokens: string;
    resetTokens: string;
  };
}> {
  const prompt = buildPromptText(
    repoData,
    taskInstruction,
    additionalContext,
    analyzeIssues,
    referenceRepoData,
    attachedDocs,
    fileTruncationLimit,
  );

  if (isTauri()) {
    const data = await invoke<any>("qwen_ai_proxy", {
      token,
      prompt,
      model: "coder-model",
      isJson: false,
      resourceUrl,
    });

    if (data.status && data.status >= 400) {
      const err: any = new Error(data.output?.error || "Qwen API Error");
      err.rateLimit = data.rateLimit;
      err.status = data.status;
      throw err;
    }

    let finalPrompt = data.output?.output?.text || "Failed to generate prompt.";

    return {
      text: finalPrompt,
      modelVersion: data.output?.model || "coder-model",
      rateLimit: data.rateLimit,
    };
  }

  const response = await fetch("/api/qwen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      resourceUrl,
      prompt,
      model: "coder-model",
      isJson: false,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const err: any = new Error(data.error || "Qwen request failed");
    err.rateLimit = data.rateLimit;
    err.status = response.status;
    throw err;
  }

  let finalPrompt = data.output?.text || "Failed to generate prompt.";

  return {
    text: finalPrompt,
    modelVersion: data.model || "coder-model",
    rateLimit: data.rateLimit,
  };
}
