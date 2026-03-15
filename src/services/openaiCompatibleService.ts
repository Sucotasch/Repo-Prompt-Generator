import { tauriFetch } from '../utils/tauriFetch';

export async function fetchOpenAICompatibleModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const response = await tauriFetch(`${baseURL.replace(/\/$/, '')}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      let errorMessage = `${response.status} ${response.statusText}`;
      const text = await response.text();
      try {
        const errorData = JSON.parse(text);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
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
      return data.data.map((model: any) => model.id);
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
  const response = await tauriFetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'user', content: promptText }
      ],
      temperature: temperature
    })
  });

  if (!response.ok) {
    let errorMessage = `${response.status} ${response.statusText}`;
    const text = await response.text();
    try {
      const errorData = JSON.parse(text);
      if (errorData.error?.message) {
        errorMessage = errorData.error.message;
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
Given a user's task description, extract MULTIPLE concrete technical search queries that would find relevant code.
Generate exactly 3 distinct queries covering different aspects of the request (e.g., one for architecture, one for dependencies, one for specific APIs).
If the user query is in another language, translate the search keywords to English to match the codebase.
Separate the 3 queries using the pipe character (|).

Also, determine the intent of the query. Is it:
- ARCHITECTURE: asking about high-level structure, patterns, or how things connect.
- BUGFIX: asking to fix a specific error or issue.
- FEATURE: asking to add new functionality.
- REFACTOR: asking to clean up or optimize existing code.
- GENERAL: anything else.

Return your response in the following JSON format:
{
  "optimizedQuery": "query 1 keywords | query 2 keywords | query 3 keywords",
  "intent": "ARCHITECTURE"
}`;

  const response = await tauriFetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    let errorMessage = `${response.status} ${response.statusText}`;
    const text = await response.text();
    try {
      const errorData = JSON.parse(text);
      if (errorData.error?.message) {
        errorMessage = errorData.error.message;
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
