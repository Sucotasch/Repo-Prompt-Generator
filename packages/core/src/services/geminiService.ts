import {
  DEFAULT_GEMINI_MODEL,
  GeminiModelId,
  GeminiThinkingLevel,
  normalizeThinkingLevel,
  resolveGeminiModel,
} from "../config/geminiModels.ts";
import { buildCodeDependencyGraph } from "../utils/codeGraph";
import { safeJsonParse } from "../utils/jsonUtils.ts";
import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import { RepoData, fetchSpecificFiles } from "./githubService";

const PLACEHOLDER_KEYS = new Set(["MY_GEMINI_API_KEY", "YOUR_GEMINI_API_KEY_HERE"]);
const MAX_TOOL_ROUNDS = 3;
const MAX_FILES_PER_CALL = 5;

function cleanExplicitGeminiKey(explicitKey?: string): string {
  const clean = explicitKey?.trim() || "";
  return clean && !PLACEHOLDER_KEYS.has(clean) ? clean : "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
}

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
      prompt += `\n<document name="${doc.name}">\n${doc.content}\n</document>\n`;
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
  prompt += `File Tree (partial):\n${repoData.tree.slice(0, 1000).join("\n")}\n\n`;

  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    const dependencyGraph = buildCodeDependencyGraph(repoData.sourceFiles);
    if (dependencyGraph) {
      prompt += `Dependency Graph (Architecture Topology):\n\`\`\`dot\n${dependencyGraph}\`\`\`\n\n`;
    }
  }

  prompt += `README:\n${truncate(repoData.readme)}\n\n`;
  prompt += `Dependencies:\n${truncate(repoData.dependencies)}\n`;
  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    prompt += `\nKey Source Files:\n${repoData.sourceFiles.map((f) => `\n<repository_file_content path="${f.path}">\n${truncate(f.content)}\n</repository_file_content>\n`).join("")}`;
  }

  if (referenceRepoData) {
    prompt += `\n\n--- REFERENCE REPOSITORY CONTEXT (READ-ONLY) ---\n`;
    prompt += `Repository Name: ${referenceRepoData.info.owner}/${referenceRepoData.info.repo}\n`;
    if (referenceRepoData.info.branch) {
      prompt += `Branch: ${referenceRepoData.info.branch}\n`;
    }
    prompt += `Description: ${referenceRepoData.info.description}\n\n`;
    prompt += `File Tree (partial):\n${referenceRepoData.tree.slice(0, 1000).join("\n")}\n\n`;

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
      prompt += `\nKey Source Files:\n${referenceRepoData.sourceFiles.map((f) => `\n<repository_file_content path="${f.path}">\n${truncate(f.content)}\n</repository_file_content>\n`).join("")}`;
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
  _proxyAddress?: string,
  signal?: AbortSignal,
): Promise<{ optimizedQuery: string; intent: string; isFallback?: boolean }> {
  if (!query || query.trim() === "") {
    return { optimizedQuery: query, intent: "GENERAL", isFallback: true };
  }
  throwIfAborted(signal);

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
    let responseText = "";
    if (isTauri()) {
      responseText = await tauriInvoke<string>("call_gemini_secure", {
        prompt,
        model: DEFAULT_GEMINI_MODEL,
        response_mime_type: "application/json",
      });
    } else {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const cleanKey = cleanExplicitGeminiKey(geminiApiKey);
      if (cleanKey) {
        headers["x-gemini-api-key"] = cleanKey;
      }
      const res = await fetch("/api/gemini/rewrite", {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({ prompt }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `Gemini rewrite error (${res.status})`);
      }
      responseText = payload.text || "{}";
    }

    throwIfAborted(signal);
    const parsed = safeJsonParse<{ optimizedQuery?: string; intent?: string } | null>(
      responseText.trim(),
      null,
    );
    if (!parsed || !parsed.optimizedQuery?.trim()) {
      return { optimizedQuery: query, intent: "GENERAL", isFallback: true };
    }
    return {
      optimizedQuery: parsed.optimizedQuery,
      intent: parsed.intent || "GENERAL",
      isFallback: false,
    };
  } catch (e: any) {
    if (e?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    console.error("Failed to rewrite query with Gemini:", e);
    return { optimizedQuery: query, intent: "GENERAL", isFallback: true };
  }
}

interface GeminiInvokeParams {
  model: GeminiModelId;
  contents: any[];
  enableDeepAnalysis: boolean;
  functionCallingMode: "AUTO" | "NONE";
  thinkingLevel: GeminiThinkingLevel;
  geminiApiKey?: string;
  signal?: AbortSignal;
}

const TAURI_DEEP_ANALYSIS_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "request_additional_files",
        description:
          "Request specific files from the repository to gain more context before answering.",
        parameters: {
          type: "OBJECT",
          properties: {
            filePaths: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List of repository file paths to fetch (max 5 per call).",
            },
          },
          required: ["filePaths"],
        },
      },
    ],
  },
];

async function invokeGeminiAdvanced(params: GeminiInvokeParams): Promise<any> {
  throwIfAborted(params.signal);

  if (isTauri()) {
    const response = await tauriInvoke<any>("call_gemini_advanced", {
      contents: params.contents,
      tools: params.enableDeepAnalysis ? TAURI_DEEP_ANALYSIS_TOOLS : null,
      tool_config: params.enableDeepAnalysis
        ? {
            functionCallingConfig: {
              mode: params.functionCallingMode,
            },
          }
        : null,
      generation_config: {
        thinkingConfig: {
          thinkingLevel: params.thinkingLevel,
        },
      },
      model: params.model,
    });
    throwIfAborted(params.signal);
    return response;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const cleanKey = cleanExplicitGeminiKey(params.geminiApiKey);
  if (cleanKey) {
    headers["x-gemini-api-key"] = cleanKey;
  }

  const res = await fetch("/api/gemini/generate", {
    method: "POST",
    headers,
    signal: params.signal,
    body: JSON.stringify({
      model: params.model,
      contents: params.contents,
      enableDeepAnalysis: params.enableDeepAnalysis,
      functionCallingMode: params.functionCallingMode,
      thinkingLevel: params.thinkingLevel,
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Gemini API error (${res.status})`);
  }
  throwIfAborted(params.signal);
  return payload;
}

function extractCandidateText(candidate: any): string {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return "";
  let text = "";
  for (const part of parts) {
    if (part?.text && !part?.thought) {
      text += part.text;
    }
  }
  if (!text.trim()) {
    for (const part of parts) {
      if (part?.text) {
        text += part.text;
      }
    }
  }
  return text;
}

function resolveGithubTokenFallback(explicitToken?: string): string | undefined {
  if (explicitToken?.trim()) return explicitToken.trim();
  try {
    const settings = localStorage.getItem("gemini_app_settings");
    if (settings) {
      return JSON.parse(settings).githubToken || undefined;
    }
  } catch {
    // ignore storage read error
  }
  return undefined;
}

export async function generateSystemPrompt(
  repoData: RepoData,
  taskInstruction: string,
  geminiApiKey: string,
  _proxyAddress: string,
  additionalContext?: string,
  analyzeIssues?: boolean,
  usedOllama?: boolean,
  referenceRepoData?: RepoData,
  attachedDocs?: { name: string; content: string }[],
  fileTruncationLimit: number = 0,
  isDeepAnalysis: boolean = false,
  onStatusUpdate?: (status: string) => void,
  localFiles?: FileList | null,
  referenceLocalFiles?: FileList | null,
  githubToken?: string,
  signal?: AbortSignal,
  geminiModel?: string,
  geminiThinkingLevel?: string,
): Promise<{
  text: string;
  modelVersion: string;
  requestedFiles?: string[];
  fetchedFilesCount?: number;
}> {
  throwIfAborted(signal);

  const resolvedModel = resolveGeminiModel(geminiModel);
  const resolvedThinkingLevel = normalizeThinkingLevel(
    resolvedModel,
    geminiThinkingLevel,
  );

  const prompt = buildPromptText(
    repoData,
    taskInstruction,
    additionalContext,
    analyzeIssues,
    referenceRepoData,
    attachedDocs,
    fileTruncationLimit,
  );

  const contents: any[] = [{ role: "user", parts: [{ text: prompt }] }];
  const requestedSet = new Set<string>();
  const alreadyFetched = new Map<string, string>();
  const token = resolveGithubTokenFallback(githubToken);

  try {
    const maxRounds = isDeepAnalysis ? MAX_TOOL_ROUNDS : 1;

    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(signal);
      const isFinalForcedRound = isDeepAnalysis && round === maxRounds - 1;

      if (round === 0) {
        onStatusUpdate?.(`Generating with ${resolvedModel}...`);
      } else if (isFinalForcedRound) {
        onStatusUpdate?.("Synthesizing final prompt from collected context...");
      } else {
        onStatusUpdate?.(`Deep Analysis round ${round + 1}/${MAX_TOOL_ROUNDS}...`);
      }

      const response = await invokeGeminiAdvanced({
        model: resolvedModel,
        contents,
        enableDeepAnalysis: isDeepAnalysis,
        functionCallingMode: isFinalForcedRound ? "NONE" : "AUTO",
        thinkingLevel: resolvedThinkingLevel,
        geminiApiKey,
        signal,
      });

      const candidate = response?.candidates?.[0];
      if (!candidate) {
        const blockReason = response?.promptFeedback?.blockReason;
        throw new Error(
          blockReason
            ? `Gemini blocked response: ${blockReason}`
            : "Gemini returned no candidates.",
        );
      }

      const candidateContent = candidate.content;
      const parts: any[] = Array.isArray(candidateContent?.parts)
        ? candidateContent.parts
        : [];
      const functionCallParts = parts.filter((p) => Boolean(p?.functionCall));

      if (functionCallParts.length === 0) {
        const text = extractCandidateText(candidate);
        if (!text.trim()) {
          throw new Error(
            `Gemini returned an empty response (finishReason: ${candidate.finishReason || "Unknown"}).`,
          );
        }
        const finalText = usedOllama
          ? `> **Note:** This context was pre-processed by local LLM.\n\n${text}`
          : text;
        return {
          text: finalText,
          modelVersion: resolvedModel,
          requestedFiles: Array.from(requestedSet),
          fetchedFilesCount: alreadyFetched.size,
        };
      }

      if (isFinalForcedRound) {
        throw new Error(
          `Model attempted to call tool '${functionCallParts[0].functionCall?.name || "unknown"}' on final synthesis step instead of returning output.`,
        );
      }

      // Preserve full candidate content (including thought + thoughtSignature)
      contents.push(candidateContent);

      // Process ALL parallel tool calls in this turn strictly 1:1 with matching call.id
      const responseParts: any[] = [];
      for (const part of functionCallParts) {
        const call = part.functionCall;
        if (call.name !== "request_additional_files") {
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: { error: `Unsupported tool '${call.name}'.` },
            },
          });
          continue;
        }

        const rawPaths: string[] = Array.isArray(call.args?.filePaths)
          ? call.args.filePaths.filter((p: unknown): p is string => typeof p === "string")
          : [];
        const batchPaths = rawPaths.slice(0, MAX_FILES_PER_CALL);
        const skippedOverLimit = rawPaths.slice(MAX_FILES_PER_CALL);

        batchPaths.forEach((p) => requestedSet.add(p));
        const toFetch = batchPaths.filter((p) => !alreadyFetched.has(p));

        if (toFetch.length > 0) {
          onStatusUpdate?.(
            `Deep Analysis: fetching ${toFetch.length} file(s)...`,
          );
          const newlyFetched = await fetchSpecificFiles(
            repoData,
            toFetch,
            token,
            referenceRepoData,
            localFiles,
            referenceLocalFiles,
            signal,
          );
          throwIfAborted(signal);
          for (const f of newlyFetched) {
            alreadyFetched.set(f.path, f.content);
          }
        }

        const filesPayload = batchPaths
          .filter((p) => alreadyFetched.has(p))
          .map((p) => ({
            path: p,
            content: `\n<repository_file_content path="${p}">\n${alreadyFetched.get(p)}\n</repository_file_content>\n`,
          }));
        const missing = batchPaths.filter((p) => !alreadyFetched.has(p));

        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: {
              files: filesPayload,
              missing,
              skippedDueToBatchLimit: skippedOverLimit,
              remainingToolRounds: Math.max(0, MAX_TOOL_ROUNDS - 2 - round),
            },
          },
        });
      }

      contents.push({
        role: "user",
        parts: responseParts,
      });
    }

    throw new Error("Deep Analysis exceeded maximum tool rounds without a final response.");
  } catch (e: any) {
    if (e?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("Generation cancelled", "AbortError");
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}
