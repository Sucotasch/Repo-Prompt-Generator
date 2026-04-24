import { isTauri, tauriInvoke } from "../utils/tauriAdapter.ts";
import { safeJsonParse } from "../utils/jsonUtils.ts";

export async function fetchOpenAICompatibleModels(
  baseURL: string,
  apiKey: string,
): Promise<string[]> {
  try {
    if (isTauri()) {
      const response = await tauriInvoke<any>("ai_network_request", {
        method: "GET",
        url: `${baseURL}/models`,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
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

    const isLocalURL = baseURL.includes('localhost') || baseURL.includes('127.0.0.1');

    if (isLocalURL) {
      const response = await fetch(`${baseURL}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
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
      body: JSON.stringify({
        baseUrl: baseURL,
        apiKey: apiKey,
      }),
    });

    if (!response.ok) {
      let errorMessage = `${response.status} ${response.statusText}`;
      const text = await response.text();
      try {
        const errorData = JSON.parse(text);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
          if (errorData.error.metadata) {
            errorMessage += ` (Metadata: ${JSON.stringify(errorData.error.metadata)})`;
          }
        } else if (errorData.message) {
          errorMessage = errorData.message;
        } else {
          errorMessage = `${errorMessage} - ${text}`;
        }
      } catch (e) {
        errorMessage = `${errorMessage} - ${text}`;
      }
      throw new Error(errorMessage);
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

export async function generate_final_prompt_with_openai_compatible(
  promptText: string,
  baseURL: string,
  apiKey: string,
  modelName: string,
  temperature: number = 0.3,
): Promise<string> {
  if (isTauri()) {
    const response = await tauriInvoke<any>("ai_network_request", {
      method: "POST",
      url: `${baseURL}/chat/completions`,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: promptText }],
        temperature: temperature,
      }),
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
      throw new Error(`OpenAI API Error: ${errorMessage}`);
    }

    const data = JSON.parse(response.text);
    return data.choices?.[0]?.message?.content || "";
  }

  const isLocalURL = baseURL.includes('localhost') || baseURL.includes('127.0.0.1');

  if (isLocalURL) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
         "Authorization": `Bearer ${apiKey}`,
         "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: promptText }],
        temperature: temperature,
      }),
    });

    if (!response.ok) {
       throw new Error(`OpenAI API Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  const response = await fetch(`/api/openai-compatible/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baseUrl: baseURL,
      apiKey: apiKey,
      payload: {
        model: modelName,
        messages: [{ role: "user", content: promptText }],
      },
    }),
  });

  if (!response.ok) {
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
      } else {
        errorMessage = `${errorMessage} - ${text}`;
      }
    } catch (e) {
      errorMessage = `${errorMessage} - ${text}`;
    }
    throw new Error(`OpenAI API Error: ${errorMessage}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function rewriteQueryWithOpenAICompatible(
  query: string,
  baseURL: string,
  apiKey: string,
  modelName: string,
): Promise<{ optimizedQuery: string; intent: string }> {
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

  if (isTauri()) {
    const response = await tauriInvoke<any>("ai_network_request", {
      method: "POST",
      url: `${baseURL}/chat/completions`,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `<user_text>\n${query}\n</user_text>` },
        ],
        temperature: 0.3,
      }),
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
      throw new Error(`OpenAI API Error: ${errorMessage}`);
    }

    const data = JSON.parse(response.text);
    const content = data.choices?.[0]?.message?.content || "";

    const parsed = safeJsonParse<{optimizedQuery?: string, intent?: string}>(content, {
      optimizedQuery: content.trim() || query,
      intent: "GENERAL",
    });

    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
    };
  }

  const isLocalURL = baseURL.includes('localhost') || baseURL.includes('127.0.0.1');

  if (isLocalURL) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `<user_text>\n${query}\n</user_text>` },
        ],
      }),
    });

    if (!response.ok) {
       throw new Error(`OpenAI API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";

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
    body: JSON.stringify({
      baseUrl: baseURL,
      apiKey: apiKey,
      payload: {
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `<user_text>\n${query}\n</user_text>` },
        ],
      },
    }),
  });

  if (!response.ok) {
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
      } else {
        errorMessage = `${errorMessage} - ${text}`;
      }
    } catch (e) {
      errorMessage = `${errorMessage} - ${text}`;
    }
    throw new Error(`OpenAI API Error: ${errorMessage}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";

  const parsed = safeJsonParse<{optimizedQuery?: string, intent?: string}>(content, {
    optimizedQuery: content.trim() || query,
    intent: "GENERAL",
  });

  return {
    optimizedQuery: parsed.optimizedQuery || query,
    intent: parsed.intent || "GENERAL",
  };
}
