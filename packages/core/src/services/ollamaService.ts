import { RepoData } from "./githubService";

export async function checkOllamaConnection(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3000), // 3s timeout for quick check
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function fetchOllamaModels(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000), // 5s timeout for model list
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.models?.map((m: any) => m.name) || [];
  } catch (e) {
    return [];
  }
}

export async function summarize_with_ollama(
  text: string,
  url: string,
  model: string,
  numCtx: number = 8192,
  numPredict: number = 250,
  temperature: number = 0.3,
): Promise<string> {
  if (!text || text.trim() === "") return "";
  const prompt = `Please summarize the following file content in a few sentences, extracting only the most important information relevant for understanding the architecture, purpose, and key logic of the code. Ignore boilerplate.\n\nContent:\n${text.substring(0, 8000)}`;

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          num_ctx: numCtx,
          num_predict: numPredict,
          temperature: temperature,
        },
      }),
    });

    if (!res.ok) throw new Error("Ollama request failed");
    const data = await res.json();
    return data.response;
  } catch (e) {
    console.error("Ollama summarization error:", e);
    return `[Ollama Summarization Failed] ${text.substring(0, 500)}...`;
  }
}

export async function rewriteQueryWithOllama(
  query: string,
  url: string,
  model: string,
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
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        format: "json",
        options: {
          num_predict: 200,
          temperature: 0.3,
        },
      }),
    });

    if (!res.ok) throw new Error("Ollama request failed");
    const data = await res.json();
    const text = data.response?.trim() || "{}";
    const parsed = JSON.parse(text);
    return {
      optimizedQuery: parsed.optimizedQuery || query,
      intent: parsed.intent || "GENERAL",
    };
  } catch (e) {
    console.error("Ollama query rewrite error:", e);
    return { optimizedQuery: query, intent: "GENERAL" };
  }
}

export async function generate_final_prompt_with_ollama(
  prompt: string,
  url: string,
  model: string,
  numCtx: number = 8192,
  numPredict: number = 2048,
  temperature: number = 0.5,
): Promise<string> {
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          num_ctx: numCtx,
          num_predict: numPredict,
          temperature: temperature,
        },
      }),
    });

    if (!res.ok) throw new Error("Ollama request failed");
    const data = await res.json();
    return data.response;
  } catch (e: any) {
    console.error("Ollama generation error:", e);
    throw new Error(
      `Ollama generation failed: ${e.message || "Unknown error"}`,
    );
  }
}

export async function isOllamaRunningNative(): Promise<boolean> {
  return false;
}

export async function startOllamaNative(): Promise<string> {
  return "Not in Tauri mode";
}

export async function stopOllamaNative(): Promise<string> {
  return "Not in Tauri mode";
}
