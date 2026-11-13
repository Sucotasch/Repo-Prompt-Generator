import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import { safeJsonParse } from "../utils/jsonUtils.ts";

function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

function buildAuthHeaders(apiKey: string, includeContentType: boolean = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  const trimmedKey = apiKey?.trim();
  if (trimmedKey) {
    headers["Authorization"] = `Bearer ${trimmedKey}`;
  }
  return headers;
}

function isLocalEndpoint(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return url.includes("localhost") || url.includes("127.0.0.1");
  }
}

function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Generation cancelled", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Generation cancelled", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function parseErrorResponse(response: Response): Promise<string> {
  let errorMessage = `${response.status} ${response.statusText}`;
  const text = await response.text();
  try {
    const errorData = JSON.parse(text);
    if (errorData.error?.message) {
      errorMessage = errorData.error.message;
      if (errorData.error?.metadata) {
        errorMessage += ` (Metadata: ${JSON.stringify(errorData.error.metadata)})`;
      }
    } else if (errorData.message) {
      errorMessage = errorData.message;
    } else if (text) {
      errorMessage = `${errorMessage} - ${text}`;
    }
  } catch {
    if (text) {
      errorMessage = `${errorMessage} - ${text}`;
    }
  }
  return errorMessage;
}

export async function fetchOpenAICompatibleModels(
  baseURL: string,
  apiKey: string,
): Promise<string[]> {
  const cleanBaseUrl = normalizeBaseUrl(baseURL);
  try {
    if (isTauri()) {
      const response = await tauriInvoke<any>("ai_network_request", {
        method: "GET",
        url: `${cleanBaseUrl}/models`,
        headers: buildAuthHeaders(apiKey),
        body: null,
      });
      
      if (response.status < 200 || response.status >= 300) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(response.text);
          if (errorData.error?.message) {
            errorMessage = errorData.error.message;
          } else if (errorData.message) {
            errorMessage = errorData.message;
          } else {
            errorMessage = `${errorMessage} - ${response.text}`;
          }
        } catch (e) {
          errorMessage = `${errorMessage} - ${response.text}`;
        }
        throw new Error(errorMessage);
      }
      
      const data = JSON.parse(response.text);
      if (data && data.data && Array.isArray(data.data)) {
        const models = data.data.map((model: any) => model.id).filter(Boolean);
        const uniqueModels = Array.from(new Set(models)) as string[];
        return uniqueModels.sort((a, b) => a.localeCompare(b));
      }
      return [];
    }

    if (isLocalEndpoint(cleanBaseUrl)) {
      const response = await fetch(`${cleanBaseUrl}/models`, {
        method: "GET",
        headers: buildAuthHeaders(apiKey),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(await parseErrorResponse(response));
      }

      const data = await response.json();
      if (data && data.data && Array.isArray(data.data)) {
        const models = data.data.map((model: any) => model.id).filter(Boolean);
        const uniqueModels = Array.from(new Set(models)) as string[];
        return uniqueModels.sort((a, b) => a.localeCompare(b));
      }
      return [];
    }

    const response = await fetch(`/api/openai-compatible/models`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        baseUrl: cleanBaseUrl,
        apiKey: apiKey?.trim() || "",
      }),
    });

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response));
    }

    const data = await response.json();
    if (data && data.data && Array.isArray(data.data)) {
      const models = data.data.map((model: any) => model.id).filter(Boolean);
      const uniqueModels = Array.from(new Set(models)) as string[];
      return uniqueModels.sort((a, b) => a.localeCompare(b));
    }
    return [];
  } catch (error) {
    console.error("Error fetching OpenAI compatible models:", error);
    throw error;
  }
}

/**
 * Safely extracts message content from an OpenAI-compatible choice,
 * supporting reasoning models (DeepSeek, Qwen, etc.) with reasoning_content or <think> tags.
 */
function extractChoiceContent(choice: any): string {
  if (!choice?.message) return "";
  const msg = choice.message;
  let text = msg.content || "";

  // Fallback for models with separate reasoning_content (DeepSeek-R1 / vLLM / OpenRouter)
  if (!text.trim() && msg.reasoning_content) {
    text = msg.reasoning_content;
  }

  // Strip <think>...</think> tags (or prefix ending with </think>) if final answer follows
  if (text.includes("<think>")) {
    const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (stripped.length > 0) {
      text = stripped;
    }
  } else if (text.includes("</think>")) {
    const afterThink = text.split("</think>").pop()?.trim();
    if (afterThink) {
      text = afterThink;
    }
  }

  return text;
}

export async function generate_final_prompt_with_openai_compatible(
  promptText: string,
  baseURL: string,
  apiKey: string,
  modelName: string,
  temperature: number = 0.3,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const cleanBaseUrl = normalizeBaseUrl(baseURL);

  if (isTauri()) {
    const response = await withAbortSignal(
      tauriInvoke<any>("ai_network_request", {
        method: "POST",
        url: `${cleanBaseUrl}/chat/completions`,
        headers: buildAuthHeaders(apiKey),
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: "user", content: promptText }],
          temperature: temperature,
        }),
      }),
      signal,
    );

    if (response.status < 200 || response.status >= 300) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = JSON.parse(response.text);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        } else if (errorData.message) {
          errorMessage = errorData.message;
        } else {
          errorMessage = `${errorMessage} - ${response.text}`;
        }
      } catch (e) {
        errorMessage = `${errorMessage} - ${response.text}`;
      }
      throw new Error(`OpenAI API Error: ${errorMessage}`);
    }

    const data = JSON.parse(response.text);
    return extractChoiceContent(data.choices?.[0]);
  }

  if (isLocalEndpoint(cleanBaseUrl)) {
    const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
      method: "POST",
      headers: buildAuthHeaders(apiKey),
      signal,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: promptText }],
        temperature: temperature,
      }),
    });

    if (!response.ok) {
       throw new Error(`OpenAI API Error: ${await parseErrorResponse(response)}`);
    }
    const data = await response.json();
    return extractChoiceContent(data.choices?.[0]);
  }

  const response = await fetch(`/api/openai-compatible/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      baseUrl: cleanBaseUrl,
      apiKey: apiKey?.trim() || "",
      payload: {
        model: modelName,
        messages: [{ role: "user", content: promptText }],
        temperature: temperature,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API Error: ${await parseErrorResponse(response)}`);
  }

  const data = await response.json();
  return extractChoiceContent(data.choices?.[0]);
}

export async function rewriteQueryWithOpenAICompatible(
  query: string,
  baseURL: string,
  apiKey: string,
  modelName: string,
  signal?: AbortSignal,
): Promise<{ optimizedQuery: string; intent: string }> {
  if (signal?.aborted) {
    throw new DOMException("Generation cancelled", "AbortError");
  }
  const systemPrompt = `You are a search query optimizer for a codebase RAG system.
Given a user's task description (which will be enclosed in <user_text> tags), extract the core technical keywords, function names, and concepts that are most likely to be found in the source code.
Output ONLY the optimized search query, nothing else. No explanations.

Also, determine the intent of the query. Is it:
- BUG_HUNT: asking to fix a specific error, issue, or bug.
- ARCHITECTURE: asking about high-level structure, patterns, or how things connect.
- UI_UX: asking about user interface, styling, or frontend components.
- DATA: asking about database, models, or data processing.
- GENERAL: anything else.

Return your response in the following JSON format:
{
  "optimizedQuery": "keyword1 keyword2 functionName",
  "intent": "ARCHITECTURE"
}`;

  const cleanBaseUrl = normalizeBaseUrl(baseURL);

  if (isTauri()) {
    const response = await withAbortSignal(
      tauriInvoke<any>("ai_network_request", {
        method: "POST",
        url: `${cleanBaseUrl}/chat/completions`,
        headers: buildAuthHeaders(apiKey),
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `<user_text>\n${query}\n</user_text>` },
          ],
          temperature: 0.3,
        }),
      }),
      signal,
    );

    if (response.status < 200 || response.status >= 300) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorData = JSON.parse(response.text);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        } else if (errorData.message) {
          errorMessage = errorData.message;
        } else {
          errorMessage = `${errorMessage} - ${response.text}`;
        }
      } catch (e) {
        errorMessage = `${errorMessage} - ${response.text}`;
      }
      throw new Error(`OpenAI API Error: ${errorMessage}`);
    }

    const data = JSON.parse(response.text);
    const content = extractChoiceContent(data.choices?.[0]);

    const parsed = safeJsonParse<{optimizedQuery?: string, intent?: string}>(content, {
      optimizedQuery: content.trim() || query,
      intent: "GENERAL",
    });

    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
    };
  }

  if (isLocalEndpoint(cleanBaseUrl)) {
    const response = await fetch(`${cleanBaseUrl}/chat/completions`, {
      method: "POST",
      headers: buildAuthHeaders(apiKey),
      signal,
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `<user_text>\n${query}\n</user_text>` },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
       throw new Error(`OpenAI API Error: ${await parseErrorResponse(response)}`);
    }

    const data = await response.json();
    const content = extractChoiceContent(data.choices?.[0]);

    const parsed = safeJsonParse<{optimizedQuery?: string, intent?: string}>(content, {
      optimizedQuery: content.trim() || query,
      intent: "GENERAL",
    });

    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
    };
  }

  const response = await fetch(`/api/openai-compatible/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      baseUrl: cleanBaseUrl,
      apiKey: apiKey?.trim() || "",
      payload: {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `<user_text>\n${query}\n</user_text>` },
        ],
        temperature: 0.3,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API Error: ${await parseErrorResponse(response)}`);
  }

  const data = await response.json();
  const content = extractChoiceContent(data.choices?.[0]);

  const parsed = safeJsonParse<{optimizedQuery?: string, intent?: string}>(content, {
    optimizedQuery: content.trim() || query,
    intent: "GENERAL",
  });

  return {
    optimizedQuery: parsed.optimizedQuery || query,
    intent: parsed.intent || "GENERAL",
  };
}
