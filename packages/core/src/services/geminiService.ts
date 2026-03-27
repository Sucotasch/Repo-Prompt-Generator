/// <reference types="vite/client" />
import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";
import { buildCodeDependencyGraph } from "../utils/codeGraph";

export function buildPromptText(
  repoData: RepoData,
  taskInstruction: string,
  additionalContext?: string,
  analyzeIssues?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: { name: string; content: string }[],
  fileTruncationLimit: number = 0,
): string {
  let prompt = ``;

  const truncate = (text: string) =>
    fileTruncationLimit === 0 ? text : text.substring(0, fileTruncationLimit);

  if (attachedDocs && attachedDocs.length > 0) {
    prompt += `<EXTERNAL_DOCUMENTS>\n`;
    attachedDocs.forEach((doc) => {
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
  prompt += `File Tree (partial):\n${repoData.tree.slice(0, 500).join("\n")}\n\n`;

  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    const dependencyGraph = buildCodeDependencyGraph(repoData.sourceFiles);
    if (dependencyGraph) {
      prompt += `Dependency Graph (Architecture Topology):\n\`\`\`dot\n${dependencyGraph}\`\`\`\n\n`;
    }
  }

  prompt += `README:\n${truncate(repoData.readme)}\n\n`;
  prompt += `Dependencies:\n${truncate(repoData.dependencies)}\n`;
  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    prompt += `\nKey Source Files:\n${repoData.sourceFiles.map((f) => `--- ${f.path} ---\n${truncate(f.content)}\n`).join("\n")}`;
  }

  if (referenceRepoData) {
    prompt += `\n\n--- REFERENCE REPOSITORY CONTEXT (READ-ONLY) ---\n`;
    prompt += `Repository Name: ${referenceRepoData.info.owner}/${referenceRepoData.info.repo}\n`;
    if (referenceRepoData.info.branch) {
      prompt += `Branch: ${referenceRepoData.info.branch}\n`;
    }
    prompt += `Description: ${referenceRepoData.info.description}\n\n`;
    prompt += `File Tree (partial):\n${referenceRepoData.tree.slice(0, 500).join("\n")}\n\n`;

    if (
      referenceRepoData.sourceFiles &&
      referenceRepoData.sourceFiles.length > 0
    ) {
      const refDependencyGraph = buildCodeDependencyGraph(
        referenceRepoData.sourceFiles,
      );
      if (refDependencyGraph) {
        prompt += `Dependency Graph (Architecture Topology):\n\`\`\`dot\n${refDependencyGraph}\`\`\`\n\n`;
      }
    }

    prompt += `README:\n${truncate(referenceRepoData.readme)}\n\n`;
    prompt += `Dependencies:\n${truncate(referenceRepoData.dependencies)}\n`;
    if (
      referenceRepoData.sourceFiles &&
      referenceRepoData.sourceFiles.length > 0
    ) {
      prompt += `\nKey Source Files:\n${referenceRepoData.sourceFiles.map((f) => `--- ${f.path} ---\n${truncate(f.content)}\n`).join("\n")}`;
    }
  }
  prompt += `\n</CODEBASE>\n\n`;

  prompt += `<FINAL_TASK>\n`;
  prompt += `PRIMARY DIRECTIVE:\n${taskInstruction}\n\n`;
  if (analyzeIssues) {
    prompt += `SECONDARY REQUEST: After completing your main primary objective, perform a brief analysis of the repository data to identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Add these findings at the end of your response.\n\n`;
  }
  if (additionalContext && additionalContext.trim()) {
    prompt += `USER ADDITIONAL CONTEXT / CONSTRAINTS:\n${additionalContext.trim()}\n\n`;
  }
  prompt += `CRITICAL REMINDER: Your absolute highest priority is to comprehensively answer and execute the user's instructions defined in the PRIMARY DIRECTIVE above. Do not lose focus on the primary objective. Ensure your final output is primarily dedicated to fulfilling that specific request.\n`;
  prompt += `</FINAL_TASK>\n`;

  return prompt;
}

export async function rewriteQueryWithGemini(
  query: string,
  geminiApiKey?: string,
  proxyAddress?: string,
): Promise<{ optimizedQuery: string; intent: string }> {
  if (!query || query.trim() === "")
    return { optimizedQuery: query, intent: "GENERAL" };

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
    const ai = new GoogleGenAI({
      apiKey: geminiApiKey || process.env.GEMINI_API_KEY || "",
    });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text || "{}";
    const cleanText = text.trim();
    const parsed = JSON.parse(cleanText);

    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
    };
  } catch (e) {
    console.error("Failed to rewrite query with Gemini:", e);
    return { optimizedQuery: query, intent: "GENERAL" };
  }
}

export async function generateSystemPrompt(
  repoData: RepoData,
  taskInstruction: string,
  geminiApiKey: string,
  proxyAddress: string,
  additionalContext?: string,
  analyzeIssues?: boolean,
  usedOllama?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: { name: string; content: string }[],
  fileTruncationLimit: number = 0,
): Promise<{ text: string; modelVersion: string }> {
  const prompt = buildPromptText(
    repoData,
    taskInstruction,
    additionalContext,
    analyzeIssues,
    referenceRepoData,
    attachedDocs,
    fileTruncationLimit,
  );

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey || process.env.GEMINI_API_KEY || "",
  });
  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: prompt,
  });

  let finalPrompt = response.text || "Failed to generate prompt.";
  if (usedOllama) {
    finalPrompt =
      `> **Note:** This context was pre-processed by local LLM.\n\n` +
      finalPrompt;
  }

  // Extract model version or fallback
  const modelVersion = "gemini-3.1-pro-preview";

  return { text: finalPrompt, modelVersion };
}
