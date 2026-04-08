import { RepoData, fetchSpecificFiles } from "./githubService";
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
CATEGORY must be one of: BUG_HUNT, ARCHITECTURE, UI_UX, DATA, GENERAL.
Query: "${query}"`;

  const callQwen = async (retryCount = 0): Promise<any> => {
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
          const err: any = new Error(data.output?.error || data.output?.message || "Qwen API Error");
          err.rateLimit = data.rateLimit;
          err.status = data.status;
          err.code = data.output?.code;
          throw err;
        }
        return data;
      } else {
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
          const err: any = new Error(data.error || data.message || "Qwen request failed");
          err.rateLimit = data.rateLimit;
          err.status = response.status;
          err.code = data.code;
          throw err;
        }
        return data;
      }
    } catch (e: any) {
      const isQuotaError = e.status === 429 && e.code === 'insufficient_quota' && e.message?.toLowerCase().includes('free allocated quota exceeded');
      
      if (e.status === 429 && !isQuotaError && retryCount < 5) {
        const delay = Math.min(60000, 4000 * Math.pow(2, retryCount));
        const jitter = delay * 0.3 * (Math.random() * 2 - 1);
        const finalDelay = Math.max(0, delay + jitter);
        
        await new Promise(resolve => setTimeout(resolve, finalDelay));
        return callQwen(retryCount + 1);
      }
      throw e;
    }
  };

  try {
    const data = await callQwen();
    let text = "{}";
    if (data.choices && data.choices.length > 0) {
      text = data.choices[0].message?.content || "{}";
    } else if (data.output?.text) {
      text = data.output.text;
    }
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
  isDeepAnalysis?: boolean,
  onStatusUpdate?: (status: string) => void,
  localFiles?: FileList | null,
  referenceLocalFiles?: FileList | null
): Promise<{
  text: string;
  modelVersion: string;
  requestedFiles?: string[];
  fetchedFilesCount?: number;
  fetchedFilesDetails?: any[];
  rateLimit?: {
    remainingRequests: string;
    resetRequests: string;
    remainingTokens: string;
    resetTokens: string;
  };
}> {
  let requestedFilesList: string[] = [];
  let fetchedFilesCount = 0;
  let fetchedFilesDetails: any[] = [];
  let finalPrompt = "";
  let currentModelVersion = "coder-model";
  let currentRateLimit: any = undefined;

  const prompt = buildPromptText(
    repoData,
    taskInstruction,
    additionalContext,
    analyzeIssues,
    referenceRepoData,
    attachedDocs,
    fileTruncationLimit,
  );

  let tools: any[] | undefined = undefined;
  if (isDeepAnalysis) {
    tools = [
      {
        type: "function",
        function: {
          name: "request_additional_files",
          description: "Request specific files from the repository to gain more context before answering.",
          parameters: {
            type: "object",
            properties: {
              filePaths: {
                type: "array",
                items: { type: "string" },
                description: "List of file paths to fetch. Max 3 files.",
              },
            },
            required: ["filePaths"],
          },
        },
      },
    ];
  }

  let messages: any[] = [
    {
      role: "system",
      content: "You are an expert software architect. Output clean markdown.",
    },
    { role: "user", content: prompt },
  ];

  const callQwen = async (currentMessages: any[], currentTools?: any[], retryCount = 0): Promise<any> => {
    try {
      if (isTauri()) {
        const payload: any = {
          token,
          prompt: "",
          messages: currentMessages,
          model: "coder-model",
          isJson: false,
          resourceUrl,
        };
        if (currentTools) payload.tools = currentTools;
        
        const data = await invoke<any>("qwen_ai_proxy", payload);

        if (data.status && data.status >= 400) {
          const err: any = new Error(data.output?.error || data.output?.message || "Qwen API Error");
          err.rateLimit = data.rateLimit;
          err.status = data.status;
          err.code = data.output?.code;
          throw err;
        }
        return data;
      } else {
        const payload: any = {
          token,
          resourceUrl,
          prompt: "",
          messages: currentMessages,
          model: "coder-model",
          isJson: false,
        };
        if (currentTools) payload.tools = currentTools;

        const response = await fetch("/api/qwen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();
        if (!response.ok) {
          const err: any = new Error(data.error || data.message || "Qwen request failed");
          err.rateLimit = data.rateLimit;
          err.status = response.status;
          err.code = data.code;
          throw err;
        }
        return data;
      }
    } catch (e: any) {
      const isQuotaError = e.status === 429 && e.code === 'insufficient_quota' && e.message?.toLowerCase().includes('free allocated quota exceeded');
      
      if (e.status === 429 && !isQuotaError && retryCount < 5) {
        const delay = Math.min(60000, 4000 * Math.pow(2, retryCount));
        const jitter = delay * 0.3 * (Math.random() * 2 - 1);
        const finalDelay = Math.max(0, delay + jitter);
        
        if (onStatusUpdate) onStatusUpdate(`Rate limit hit. Retrying in ${Math.round(finalDelay / 1000)}s (Attempt ${retryCount + 1}/5)...`);
        await new Promise(resolve => setTimeout(resolve, finalDelay));
        if (onStatusUpdate) onStatusUpdate(`Retrying request (Attempt ${retryCount + 1}/5)...`);
        return callQwen(currentMessages, currentTools, retryCount + 1);
      }
      throw e;
    }
  };

  try {
    if (onStatusUpdate) onStatusUpdate("Analyzing project structure...");
    let data = await callQwen(messages, tools);
    currentModelVersion = data.model || "coder-model";
    currentRateLimit = data.rateLimit;

    let message = data.choices && data.choices.length > 0 ? data.choices[0].message : data.output?.message;
    
    let toolCall = undefined;
    if (message?.tool_calls && message.tool_calls.length > 0) {
      toolCall = message.tool_calls[0];
    } else if (message?.function_call) {
      toolCall = {
        id: "call_" + Math.random().toString(36).substring(7),
        function: message.function_call
      };
      message.tool_calls = [toolCall];
      delete message.function_call;
    }

    if (toolCall) {
      if (toolCall.function?.name === "request_additional_files") {
        let args: any = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch (e) {
          console.error("Failed to parse tool call arguments:", e);
        }

        const requestedFiles = args.filePaths || [];
        requestedFilesList = requestedFiles;
        if (onStatusUpdate) onStatusUpdate(`Requesting additional files (${requestedFiles.length})...`);
        
        const fetchedFiles = await fetchSpecificFiles(repoData, requestedFiles, token, referenceRepoData, localFiles, referenceLocalFiles);
        fetchedFilesCount = fetchedFiles.length;
        fetchedFilesDetails = fetchedFiles.map(f => ({
          path: f.path,
          truncated: f.content.includes("[TRUNCATED:")
        }));
        
        let instructionText = "";
        if (fetchedFiles.length === 0) {
          if (onStatusUpdate) onStatusUpdate("Failed to fetch files. Generating fallback response...");
          instructionText = "\n\nCRITICAL INSTRUCTION: The requested files could not be fetched or were empty. You MUST now provide the final answer based on the initial context. Do NOT request any more files. Provide the final output directly.";
        } else {
          if (onStatusUpdate) onStatusUpdate(`Successfully fetched ${fetchedFiles.length} files. Generating final response...`);
          instructionText = "\n\nCRITICAL INSTRUCTION: You have received the requested files. You MUST now provide the final answer based on these files. Do NOT request any more files. Provide the final output directly.";
        }

        if (message && !message.content) {
          message.content = "";
        }
        messages.push(message);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id || toolCall.function?.name,
          name: toolCall.function?.name,
          content: instructionText + "\n\n" + JSON.stringify({ files: fetchedFiles })
        });

        data = await callQwen(messages, undefined);
        currentModelVersion = data.model || "coder-model";
        currentRateLimit = data.rateLimit;
        message = data.choices && data.choices.length > 0 ? data.choices[0].message : data.output?.message;
      }
    }

    finalPrompt = (data.choices && data.choices.length > 0 ? data.choices[0].message?.content : data.output?.text) || message?.content || "Failed to generate prompt.";
  } catch (e: any) {
    console.error("Failed to generate prompt with Qwen:", e);
    finalPrompt = `Error: ${e.message || e}`;
    currentRateLimit = e.rateLimit;
  }

  if (usedOllama) {
    finalPrompt =
      `> **Note:** This context was pre-processed by local LLM.\n\n` +
      finalPrompt;
  }

  return {
    text: finalPrompt,
    modelVersion: currentModelVersion,
    requestedFiles: requestedFilesList,
    fetchedFilesCount,
    fetchedFilesDetails,
    rateLimit: currentRateLimit,
  };
}
