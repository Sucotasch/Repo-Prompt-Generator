import { RepoData } from "./githubService";
import { buildPromptText } from "./geminiService";
import { isTauri } from "../utils/tauri";
import { tauriFetch } from "../utils/tauriFetch";

let lastQwenRequestTime = 0;
const QWEN_MIN_DELAY_MS = 2500; // 2.5 seconds minimum delay between requests

async function enforceQwenRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastQwenRequestTime;
  if (timeSinceLastRequest < QWEN_MIN_DELAY_MS) {
    const delay = QWEN_MIN_DELAY_MS - timeSinceLastRequest;
    console.log(`Enforcing Qwen rate limit: pausing for ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

function updateQwenRequestTime() {
  lastQwenRequestTime = Date.now();
}

export async function rewriteQueryWithQwen(query: string, token: string, resourceUrl?: string): Promise<{optimizedQuery: string, intent: string, rateLimit?: { remainingRequests: string, resetRequests: string, remainingTokens: string, resetTokens: string }}> {
  if (!query?.trim()) return { optimizedQuery: query, intent: 'GENERAL' };

  const prompt = `Optimize the search query for RAG over a code repository. Extract 3 distinct technical queries separated by |. If the query is not in English, translate keywords to English. Return ONLY JSON:
{"optimizedQuery":"query 1 | query 2 | query 3", "intent":"CATEGORY"}
Query: "${query}"`;

  try {
    await enforceQwenRateLimit();
    
    let response;
    if (isTauri()) {
      const payload: any = {
        model: "coder-model",
        messages: [
          { role: "system", content: "You are an expert software architect. Output clean markdown." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      };

      let endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
      if (resourceUrl) {
        let baseUrl = resourceUrl;
        if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
          baseUrl = "https://" + baseUrl;
        }
        try {
          const urlObj = new URL(baseUrl);
          if (urlObj.pathname === "/" || urlObj.pathname === "") {
             endpoint = new URL("/v1/chat/completions", baseUrl).toString();
          } else {
             endpoint = baseUrl;
          }
        } catch (e) {
          endpoint = baseUrl;
        }
      }

      response = await tauriFetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
    } else {
      response = await fetch("/api/qwen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          resourceUrl,
          prompt,
          model: "coder-model",
          isJson: true
        })
      });
    }
    
    updateQwenRequestTime();

    const data = await response.json();
    if (!response.ok) {
      const err: any = new Error(data.error || "Qwen request failed");
      err.rateLimit = data.rateLimit;
      err.status = response.status;
      throw err;
    }

    let text = '{}';
    if (isTauri()) {
      text = data.choices?.[0]?.message?.content || '{}';
    } else {
      text = data.output?.text || '{}';
    }
    
    const parsed = JSON.parse(text);
    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || 'GENERAL',
      rateLimit: data.rateLimit
    };
  } catch (e: any) {
    console.error("Failed to rewrite query with Qwen:", e);
    return { optimizedQuery: query, intent: 'GENERAL', rateLimit: e.rateLimit };
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
  attachedDocs?: {name: string, content: string}[],
  resourceUrl?: string,
  fileTruncationLimit?: number
): Promise<{ text: string, modelVersion: string, rateLimit?: { remainingRequests: string, resetRequests: string, remainingTokens: string, resetTokens: string } }> {

  const prompt = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs, fileTruncationLimit);

  await enforceQwenRateLimit();
  
  let response;
  if (isTauri()) {
    const payload: any = {
      model: "coder-model",
      messages: [
        { role: "system", content: "You are an expert software architect. Output clean markdown." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    };

    let endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    if (resourceUrl) {
      let baseUrl = resourceUrl;
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        baseUrl = "https://" + baseUrl;
      }
      try {
        const urlObj = new URL(baseUrl);
        if (urlObj.pathname === "/" || urlObj.pathname === "") {
           endpoint = new URL("/v1/chat/completions", baseUrl).toString();
        } else {
           endpoint = baseUrl;
        }
      } catch (e) {
        endpoint = baseUrl;
      }
    }

    response = await tauriFetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } else {
    response = await fetch("/api/qwen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        resourceUrl,
        prompt,
        model: "coder-model",
        isJson: false
      })
    });
  }
  
  updateQwenRequestTime();

  const data = await response.json();
  if (!response.ok) {
    const err: any = new Error(data.error || "Qwen request failed");
    err.rateLimit = data.rateLimit;
    err.status = response.status;
    throw err;
  }

  let finalPrompt = "Failed to generate prompt.";
  if (isTauri()) {
    finalPrompt = data.choices?.[0]?.message?.content || finalPrompt;
  } else {
    finalPrompt = data.output?.text || finalPrompt;
  }

  return { 
    text: finalPrompt, 
    modelVersion: data.model || "coder-model",
    rateLimit: data.rateLimit
  };
}
