import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
  GeminiModelId,
  GeminiThinkingLevel,
  normalizeThinkingLevel,
  resolveGeminiModel,
} from "../config/geminiModels.ts";
import { buildCodeDependencyGraph } from "../utils/codeGraph";
import { safeJsonParse } from "../utils/jsonUtils.ts";
import {
  stripTrailingTruncationNotice,
  truncateAtLineBoundary,
} from "../utils/pathFilters.ts";
import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import {
  RepoData,
  RepoSourceFile,
  fetchFileRange,
  fetchSpecificFiles,
  grepRepository,
} from "./githubService";

const PLACEHOLDER_KEYS = new Set(["MY_GEMINI_API_KEY", "YOUR_GEMINI_API_KEY_HERE"]);
const DEFAULT_DEEP_ANALYSIS_ROUNDS = 4; // 3 tool rounds + 1 final forced synthesis round
const MAX_TOTAL_TOOL_CHARS_CEILING = 800_000; // ~200K tokens hard ceiling to guard multi-turn API cost
const MAX_RANGE_CALLS_PER_TURN = 15;
const MAX_GREP_CALLS_PER_TURN = 6;

export interface DeepAnalysisBudget {
  modelContextTokens: number;
  initialPromptTokens: number;
  maxTotalToolChars: number;
  maxFilesPerCall: number;
  maxToolRounds: number;
  maxRangeCallsPerTurn: number;
  maxGrepCallsPerTurn: number;
}

export function computeDeepAnalysisBudget(
  modelId: GeminiModelId,
  initialPromptChars: number,
  options: { hasGithubToken: boolean; isLocalRepo: boolean; isTauriRuntime?: boolean },
): DeepAnalysisBudget {
  const spec = GEMINI_MODELS[modelId] ?? GEMINI_MODELS[DEFAULT_GEMINI_MODEL];
  const modelContextTokens = spec.contextWindowTokens || 1_048_576;
  const initialPromptTokens = Math.ceil(initialPromptChars / 4);

  // Reserve ~45% of context window for output, thinking tokens, and multi-turn conversation framing
  const availableToolTokens = Math.max(
    16_000,
    Math.floor(modelContextTokens * 0.55) - initialPromptTokens,
  );
  const maxTotalToolChars = Math.min(availableToolTokens * 4, MAX_TOTAL_TOOL_CHARS_CEILING);

  // Scale batch fetch cap with context budget while respecting unauthenticated GitHub REST rate limits
  const sourceCap =
    options.isLocalRepo || options.hasGithubToken || !options.isTauriRuntime ? 20 : 10;
  const budgetDerivedFiles = Math.floor(maxTotalToolChars / 25_000);
  const maxFilesPerCall = Math.max(3, Math.min(sourceCap, budgetDerivedFiles));

  return {
    modelContextTokens,
    initialPromptTokens,
    maxTotalToolChars,
    maxFilesPerCall,
    maxToolRounds: DEFAULT_DEEP_ANALYSIS_ROUNDS,
    maxRangeCallsPerTurn: MAX_RANGE_CALLS_PER_TURN,
    maxGrepCallsPerTurn: MAX_GREP_CALLS_PER_TURN,
  };
}

function cleanExplicitGeminiKey(explicitKey?: string): string {
  const clean = explicitKey?.trim() || "";
  return clean && !PLACEHOLDER_KEYS.has(clean) ? clean : "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
}

function formatSourceFileForPrompt(
  file: RepoSourceFile,
  fileTruncationLimit: number,
): {
  block: string;
  manifestLine: string | null;
  isRealFile: boolean;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated: boolean;
} {
  const normalizedPath = file.path.replace(/\s+\(Part \d+\)$/i, "");
  const isRagSnippet = /\s+\(Part \d+\)$/i.test(file.path) || file.ragScore !== undefined;

  if (file.isSummary) {
    // Zone pseudo-headers or Ollama-compressed summaries must never get fake source line numbers
    if (file.path.startsWith("--- ZONE:")) {
      return {
        block: `\n${file.path}\n${file.content}\n`,
        manifestLine: null,
        isRealFile: false,
        truncated: false,
      };
    }
    const summaryCut = truncateAtLineBoundary(file.content, fileTruncationLimit);
    const truncatedSummary = summaryCut.truncated
      ? `${summaryCut.text}\n... [SUMMARY TRUNCATED]`
      : summaryCut.text;
    return {
      block: `\n<repository_file_content path="${file.path}" summary="true">\n${truncatedSummary}\n</repository_file_content>\n`,
      manifestLine: `  - ${normalizedPath} (local LLM summary; source line numbers unavailable)`,
      isRealFile: true,
      truncated: summaryCut.truncated,
    };
  }

  const normalizedRaw = file.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const { cleanText, hadNotice } = stripTrailingTruncationNotice(normalizedRaw);
  const startLine = file.startLine ?? 1;
  const cleanLineCount = cleanText.split("\n").length;
  const totalLines = file.totalLines ?? (startLine + cleanLineCount - 1);

  const cut = truncateAtLineBoundary(cleanText, fileTruncationLimit);
  const effectiveText = cut.text;
  const cutByCharLimit = cut.truncated;

  const lines = effectiveText.split("\n");
  const endLine = startLine + lines.length - 1;
  const isTruncated = Boolean(
    file.truncated || hadNotice || cutByCharLimit || startLine > 1 || endLine < totalLines,
  );

  const numbered = lines
    .map((line, idx) => `${startLine + idx}: ${line}`)
    .join("\n");

  const attrs = [
    `path="${file.path}"`,
    `lines="${startLine}-${endLine}"`,
    `total_lines="${totalLines}"`,
    `truncated="${isTruncated}"`,
  ];
  if (file.ragScore !== undefined) {
    attrs.push(`rag_score="${file.ragScore}"`);
  }

  const footer = isTruncated
    ? `\n... [TRUNCATED: showing lines ${startLine}-${endLine} of ${totalLines}]`
    : "";

  const statusTag = isRagSnippet
    ? `rag-snippet, lines ${startLine}-${endLine} of ${totalLines}`
    : isTruncated
      ? `truncated, lines ${startLine}-${endLine} of ${totalLines}`
      : `full, lines ${startLine}-${endLine} of ${totalLines}`;

  return {
    block: `\n<repository_file_content ${attrs.join(" ")}>\n${numbered}${footer}\n</repository_file_content>\n`,
    manifestLine: `  - ${file.path} (${statusTag})`,
    isRealFile: true,
    startLine,
    endLine,
    totalLines,
    truncated: isTruncated,
  };
}

function buildRepositoryManifest(
  label: string,
  data: RepoData,
  formattedFiles: { manifestLine: string | null; isRealFile: boolean; rawPath: string }[],
): string {
  const totalTree = data.totalTreeFiles ?? data.tree.length;
  const listedTree = data.tree.length;
  const uniqueIncluded = new Set(
    formattedFiles
      .filter((f) => f.isRealFile)
      .map((f) => f.rawPath.replace(/\s+\(Part \d+\)$/i, "")),
  );
  const notIncluded = Math.max(0, totalTree - uniqueIncluded.size);
  const manifestLines = formattedFiles
    .map((f) => f.manifestLine)
    .filter((l): l is string => Boolean(l));

  let out = `--- ${label} MANIFEST ---\n`;
  out += `Repository: ${data.info.owner}/${data.info.repo}\n`;
  if (data.info.branch) {
    out += `Branch: ${data.info.branch}\n`;
  }
  if (data.info.commitSha) {
    out += `Commit SHA: ${data.info.commitSha}\n`;
  }
  if (data.info.treeSha) {
    out += `Tree SHA: ${data.info.treeSha}\n`;
  }
  if (data.info.fetchedAt) {
    out += `Snapshot Time: ${data.info.fetchedAt}\n`;
  }
  out += `Total Repository Files (after ignore filters): ${totalTree}\n`;
  out += `File Tree Listed: ${listedTree} of ${totalTree}${data.isTruncated ? " (tree truncated at 1000)" : ""}\n`;
  out += `Files Shown in Initial Context: ${uniqueIncluded.size} unique file(s); Not Shown: ${notIncluded} file(s)\n`;
  if (manifestLines.length > 0) {
    out += `Included File Coverage:\n${manifestLines.join("\n")}\n`;
  }
  return out + "\n";
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
    truncateAtLineBoundary(text, fileTruncationLimit).text;

  if (attachedDocs && attachedDocs.length > 0) {
    prompt += `<EXTERNAL_DOCUMENTS>\n`;
    attachedDocs.forEach((doc) => {
      prompt += `\n<document name="${doc.name}">\n${doc.content}\n</document>\n`;
    });
    prompt += `</EXTERNAL_DOCUMENTS>\n\n`;
  }

  const targetFormatted = (repoData.sourceFiles || []).map((f) => ({
    rawPath: f.path,
    ...formatSourceFileForPrompt(f, fileTruncationLimit),
  }));

  prompt += `<CODEBASE>\n`;
  prompt += buildRepositoryManifest("TARGET REPOSITORY", repoData, targetFormatted);
  prompt += `--- TARGET REPOSITORY CONTEXT ---\n`;
  prompt += `Repository Name: ${repoData.info.owner}/${repoData.info.repo}\n`;
  if (repoData.info.branch) {
    prompt += `Branch: ${repoData.info.branch}\n`;
  }
  prompt += `Description: ${repoData.info.description}\n\n`;
  prompt += `File Tree (${repoData.tree.length} of ${repoData.totalTreeFiles ?? repoData.tree.length}):\n${repoData.tree.slice(0, 1000).join("\n")}\n\n`;

  if (repoData.sourceFiles && repoData.sourceFiles.length > 0) {
    const dependencyGraph = buildCodeDependencyGraph(repoData.sourceFiles);
    if (dependencyGraph) {
      prompt += `Dependency Graph (Architecture Topology):\n\`\`\`dot\n${dependencyGraph}\`\`\`\n\n`;
    }
  }

  prompt += `README:\n${truncate(repoData.readme)}\n\n`;
  prompt += `Dependencies:\n${truncate(repoData.dependencies)}\n`;
  if (targetFormatted.length > 0) {
    prompt += `\nKey Source Files:\n${targetFormatted.map((f) => f.block).join("")}`;
  }

  if (referenceRepoData) {
    const refFormatted = (referenceRepoData.sourceFiles || []).map((f) => ({
      rawPath: f.path,
      ...formatSourceFileForPrompt(f, fileTruncationLimit),
    }));

    prompt += `\n\n`;
    prompt += buildRepositoryManifest("REFERENCE REPOSITORY", referenceRepoData, refFormatted);
    prompt += `--- REFERENCE REPOSITORY CONTEXT (READ-ONLY) ---\n`;
    prompt += `Repository Name: ${referenceRepoData.info.owner}/${referenceRepoData.info.repo}\n`;
    if (referenceRepoData.info.branch) {
      prompt += `Branch: ${referenceRepoData.info.branch}\n`;
    }
    prompt += `Description: ${referenceRepoData.info.description}\n\n`;
    prompt += `File Tree (${referenceRepoData.tree.length} of ${referenceRepoData.totalTreeFiles ?? referenceRepoData.tree.length}):\n${referenceRepoData.tree.slice(0, 1000).join("\n")}\n\n`;

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
    if (refFormatted.length > 0) {
      prompt += `\nKey Source Files:\n${refFormatted.map((f) => f.block).join("")}`;
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
  prompt += `EVIDENCE & LINE-NUMBERING RULES (MANDATORY):\n`;
  prompt += `- Inside <repository_file_content>, every line of source code is prefixed with its 1-indexed file line number ("<line>: <code>"). Attributes indicate "lines", "total_lines", and whether content was "truncated".\n`;
  prompt += `- Only cite exact line numbers that you directly observe in a numbered <repository_file_content> block (never cite line numbers for entries marked summary="true" or for truncated/unseen sections).\n`;
  prompt += `- Distinguish evidence levels explicitly for technical claims, findings, or bugs: mark directly observed code facts as [Verified] (with path:line), deductions from signatures/imports/tree as [Inferred], and unexamined/truncated code as [Not inspected] (explicitly name files or line ranges you did not see rather than guessing).\n\n`;
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
        name: "grep_repository",
        description:
          "Search repository text files for a literal string or regex pattern, returning matching file paths, 1-indexed line numbers, and line previews. Use this to locate symbols, identifiers, or references before reading code with request_file_range.",
        parameters: {
          type: "OBJECT",
          properties: {
            pattern: {
              type: "STRING",
              description:
                "Regex or plain-text pattern to search for (max 200 chars; invalid regex falls back to literal match).",
            },
            pathPrefix: {
              type: "STRING",
              description:
                "Optional directory or file path prefix filter (e.g., 'src/services/').",
            },
            caseSensitive: {
              type: "BOOLEAN",
              description: "Whether matching is case-sensitive (default false).",
            },
            maxMatches: {
              type: "INTEGER",
              description: "Maximum matches to return (default 40, max 100).",
            },
            repo: {
              type: "STRING",
              description:
                "Optional repository target when both target and reference repos exist: 'target' or 'reference'.",
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "request_file_range",
        description:
          "Read a specific 1-indexed line range (up to 400 lines per call) from a repository file, including sections omitted by truncation or files not included in initial context. Preferred for inspecting truncated files or targeted line ranges.",
        parameters: {
          type: "OBJECT",
          properties: {
            path: {
              type: "STRING",
              description: "Exact repository file path from the File Tree.",
            },
            startLine: {
              type: "INTEGER",
              description: "1-indexed start line number (inclusive, default 1).",
            },
            endLine: {
              type: "INTEGER",
              description:
                "1-indexed end line number (inclusive, max 400 lines per call; defaults to startLine + 249).",
            },
            repo: {
              type: "STRING",
              description:
                "Optional repository target when both target and reference repos exist: 'target' or 'reference'.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "request_additional_files",
        description:
          "Request initial slices of multiple repository files at once (batch cap scales dynamically with context budget, up to 20 files per call). For large or truncated files, prefer request_file_range to inspect specific line windows.",
        parameters: {
          type: "OBJECT",
          properties: {
            filePaths: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "List of repository file paths to fetch.",
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
  grepQueries?: string[];
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
  const grepSet = new Set<string>();
  const alreadyFetched = new Map<string, RepoSourceFile>();
  const fetchedRangeKeys = new Set<string>();
  const token = resolveGithubTokenFallback(githubToken);

  const budget = computeDeepAnalysisBudget(resolvedModel, prompt.length, {
    hasGithubToken: Boolean(token),
    isLocalRepo: repoData.info.owner === "local",
    isTauriRuntime: isTauri(),
  });
  let accumulatedToolChars = 0;

  try {
    const maxRounds = isDeepAnalysis ? budget.maxToolRounds : 1;

    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(signal);
      const isFinalForcedRound = isDeepAnalysis && round === maxRounds - 1;

      if (round === 0) {
        onStatusUpdate?.(`Generating with ${resolvedModel}...`);
      } else if (isFinalForcedRound) {
        onStatusUpdate?.("Synthesizing final prompt from collected context...");
      } else {
        onStatusUpdate?.(`Deep Analysis round ${round + 1}/${maxRounds}...`);
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
          fetchedFilesCount: alreadyFetched.size + fetchedRangeKeys.size,
          grepQueries: Array.from(grepSet),
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
      let rangeCallsInTurn = 0;
      let grepCallsInTurn = 0;

      for (const part of functionCallParts) {
        const call = part.functionCall;
        const remainingToolRounds = Math.max(0, maxRounds - 2 - round);
        const remainingToolBudgetChars = Math.max(
          0,
          budget.maxTotalToolChars - accumulatedToolChars,
        );

        if (call.name === "grep_repository") {
          const pattern = typeof call.args?.pattern === "string" ? call.args.pattern.trim() : "";
          const pathPrefix =
            typeof call.args?.pathPrefix === "string" ? call.args.pathPrefix.trim() : undefined;
          const caseSensitive = Boolean(call.args?.caseSensitive);
          const maxMatches =
            call.args?.maxMatches !== undefined && call.args?.maxMatches !== null
              ? Number(call.args.maxMatches)
              : undefined;
          const repoHint =
            call.args?.repo === "target" || call.args?.repo === "reference"
              ? call.args.repo
              : undefined;

          if (!pattern) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  error: "Parameter 'pattern' must be a non-empty search string.",
                  remainingToolRounds,
                  remainingToolBudgetChars,
                },
              },
            });
            continue;
          }

          if (grepCallsInTurn >= budget.maxGrepCallsPerTurn) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  error: `Per-turn grep limit (${budget.maxGrepCallsPerTurn}) reached.`,
                  skippedDueToTurnLimit: true,
                  remainingToolRounds,
                  remainingToolBudgetChars,
                },
              },
            });
            continue;
          }

          grepCallsInTurn++;
          const grepLabel = pathPrefix ? `${pattern} (${pathPrefix})` : pattern;
          grepSet.add(grepLabel);
          onStatusUpdate?.(`Deep Analysis: searching '${pattern.slice(0, 40)}'...`);

          const grepRes = await grepRepository(
            repoData,
            pattern,
            { pathPrefix, caseSensitive, maxMatches, repoHint },
            token,
            referenceRepoData,
            localFiles,
            referenceLocalFiles,
            signal,
          );
          throwIfAborted(signal);

          const grepPayloadSize = JSON.stringify(grepRes.matches).length;
          accumulatedToolChars += grepPayloadSize;

          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: {
                ...grepRes,
                remainingToolRounds,
                remainingToolBudgetChars: Math.max(
                  0,
                  budget.maxTotalToolChars - accumulatedToolChars,
                ),
              },
            },
          });
          continue;
        }

        if (call.name === "request_file_range") {
          const reqPath = typeof call.args?.path === "string" ? call.args.path.trim() : "";
          const rawStart =
            call.args?.startLine !== undefined && call.args?.startLine !== null
              ? Number(call.args.startLine)
              : 1;
          const rawEnd =
            call.args?.endLine !== undefined && call.args?.endLine !== null
              ? Number(call.args.endLine)
              : undefined;
          const repoHint =
            call.args?.repo === "target" || call.args?.repo === "reference"
              ? call.args.repo
              : undefined;

          if (!reqPath) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  error: "Parameter 'path' must be a non-empty repository file path.",
                  remainingToolRounds,
                  remainingToolBudgetChars,
                },
              },
            });
            continue;
          }

          if (remainingToolBudgetChars <= 0) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  path: reqPath,
                  error:
                    "Context tool character budget exhausted; synthesize answer from collected evidence.",
                  budgetExhausted: true,
                  remainingToolRounds,
                  remainingToolBudgetChars: 0,
                },
              },
            });
            continue;
          }

          if (rangeCallsInTurn >= budget.maxRangeCallsPerTurn) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  path: reqPath,
                  error: `Per-turn range request limit (${budget.maxRangeCallsPerTurn}) reached.`,
                  skippedDueToTurnLimit: true,
                  remainingToolRounds,
                  remainingToolBudgetChars,
                },
              },
            });
            continue;
          }

          rangeCallsInTurn++;
          const safeStartDisplay = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
          const rangeLabel =
            rawEnd !== undefined && Number.isFinite(rawEnd)
              ? `${reqPath}:${safeStartDisplay}-${Math.floor(rawEnd)}`
              : `${reqPath}:${safeStartDisplay}+`;
          requestedSet.add(rangeLabel);

          onStatusUpdate?.(`Deep Analysis: reading ${rangeLabel}...`);
          const rangeFile = await fetchFileRange(
            repoData,
            reqPath,
            rawStart,
            rawEnd,
            token,
            referenceRepoData,
            localFiles,
            referenceLocalFiles,
            signal,
            repoHint,
          );
          throwIfAborted(signal);

          if (rangeFile.error) {
            responseParts.push({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  path: reqPath,
                  totalLines: rangeFile.totalLines,
                  outOfRange: Boolean(rangeFile.outOfRange),
                  error: rangeFile.error,
                  remainingToolRounds,
                  remainingToolBudgetChars,
                },
              },
            });
            continue;
          }

          fetchedRangeKeys.add(rangeLabel);
          // Do not re-apply user's initial fileTruncationLimit to an explicit line-range request
          const formatted = formatSourceFileForPrompt(rangeFile, 0);
          accumulatedToolChars += formatted.block.length;
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: {
                path: rangeFile.path,
                startLine: rangeFile.startLine,
                endLine: rangeFile.endLine,
                lines: `${rangeFile.startLine ?? 1}-${rangeFile.endLine ?? "?"}`,
                totalLines: rangeFile.totalLines,
                truncated: Boolean(rangeFile.truncated),
                content: formatted.block,
                remainingToolRounds,
                remainingToolBudgetChars: Math.max(
                  0,
                  budget.maxTotalToolChars - accumulatedToolChars,
                ),
              },
            },
          });
          continue;
        }

        if (call.name !== "request_additional_files") {
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: {
                error: `Unsupported tool '${call.name}'.`,
                remainingToolRounds,
                remainingToolBudgetChars,
              },
            },
          });
          continue;
        }

        if (remainingToolBudgetChars <= 0) {
          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: {
                files: [],
                missing: [],
                error:
                  "Context tool character budget exhausted; synthesize answer from collected evidence.",
                budgetExhausted: true,
                remainingToolRounds,
                remainingToolBudgetChars: 0,
              },
            },
          });
          continue;
        }

        const rawPaths: string[] = Array.isArray(call.args?.filePaths)
          ? call.args.filePaths.filter((p: unknown): p is string => typeof p === "string")
          : [];
        const dynamicBatchCap = Math.max(
          1,
          Math.min(
            budget.maxFilesPerCall,
            Math.max(1, Math.floor(remainingToolBudgetChars / 20_000)),
          ),
        );
        const batchPaths = rawPaths.slice(0, dynamicBatchCap);
        const skippedOverLimit = rawPaths.slice(dynamicBatchCap);

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
            dynamicBatchCap,
          );
          throwIfAborted(signal);
          for (const f of newlyFetched) {
            alreadyFetched.set(f.path, f);
          }
        }

        const filesPayload: {
          path: string;
          lines: string;
          totalLines?: number;
          truncated: boolean;
          content: string;
        }[] = [];
        const skippedDueToBudget: string[] = [];

        for (const p of batchPaths) {
          if (!alreadyFetched.has(p)) continue;
          const fileObj = alreadyFetched.get(p)!;
          const formatted = formatSourceFileForPrompt(fileObj, fileTruncationLimit);
          if (
            filesPayload.length > 0 &&
            accumulatedToolChars + formatted.block.length > budget.maxTotalToolChars
          ) {
            skippedDueToBudget.push(p);
            continue;
          }
          accumulatedToolChars += formatted.block.length;
          filesPayload.push({
            path: p,
            lines: `${formatted.startLine ?? 1}-${formatted.endLine ?? "?"}`,
            totalLines: formatted.totalLines,
            truncated: formatted.truncated,
            content: formatted.block,
          });
        }
        const missing = batchPaths.filter((p) => !alreadyFetched.has(p));

        responseParts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: {
              files: filesPayload,
              missing,
              skippedDueToBatchLimit: skippedOverLimit,
              skippedDueToBudget: skippedDueToBudget.length > 0 ? skippedDueToBudget : undefined,
              dynamicBatchCap,
              remainingToolRounds,
              remainingToolBudgetChars: Math.max(
                0,
                budget.maxTotalToolChars - accumulatedToolChars,
              ),
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
