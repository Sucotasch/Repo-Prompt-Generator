export async function fetchOpenAICompatibleModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(`/api/openai-compatible/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        baseUrl: baseURL,
        apiKey: apiKey
      })
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
  temperature: number = 0.3
): Promise<string> {
  const response = await fetch(`/api/openai-compatible/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      baseUrl: baseURL,
      apiKey: apiKey,
      payload: {
        model: modelName,
        messages: [
          { role: 'user', content: promptText }
        ]
      }
    })
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
  return data.choices?.[0]?.message?.content || '';
}

export async function rewriteQueryWithOpenAICompatible(
  query: string,
  baseURL: string,
  apiKey: string,
  modelName: string
): Promise<{optimizedQuery: string, intent: string}> {
  const systemPrompt = `You are a search query optimizer for a codebase RAG system.
Given a user's task description, extract the core technical keywords, function names, and concepts that are most likely to be found in the source code.
Output ONLY the optimized search query, nothing else. No explanations.

Also, determine the intent of the query. Is it:
- ARCHITECTURE: asking about high-level structure, patterns, or how things connect.
- BUGFIX: asking to fix a specific error or issue.
- FEATURE: asking to add new functionality.
- REFACTOR: asking to clean up or optimize existing code.
- GENERAL: anything else.

Return your response in the following JSON format:
{
  "optimizedQuery": "keyword1 keyword2 functionName",
  "intent": "ARCHITECTURE"
}`;

  const response = await fetch(`/api/openai-compatible/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      baseUrl: baseURL,
      apiKey: apiKey,
      payload: {
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ]
      }
    })
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
  const content = data.choices?.[0]?.message?.content || '';
  
  try {
    const parsed = JSON.parse(content);
    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || 'GENERAL'
    };
  } catch (e) {
    console.warn("Failed to parse JSON from OpenAI compatible API, falling back to raw text", e);
    return {
      optimizedQuery: content.trim() || query,
      intent: 'GENERAL'
    };
  }
}
