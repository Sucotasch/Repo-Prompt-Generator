import { RepoData } from './githubService';

export async function checkOllamaConnection(url: string): Promise<boolean> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('ollama_check_connection', { url });
  }
  try {
    const res = await fetch(`${url}/api/tags`);
    return res.ok;
  } catch (e) {
    return false;
  }
}

export async function fetchOllamaModels(url: string): Promise<string[]> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('ollama_fetch_models', { url });
  }
  try {
    const res = await fetch(`${url}/api/tags`);
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
  temperature: number = 0.3
): Promise<string> {
  if (!text || text.trim() === '') return '';
  const prompt = `Please summarize the following file content in a few sentences, extracting only the most important information relevant for understanding the architecture, purpose, and key logic of the code. Ignore boilerplate.\n\nContent:\n${text.substring(0, 8000)}`;

  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke('ollama_generate', {
        url,
        model,
        prompt,
        numCtx,
        numPredict,
        temperature
      });
    } catch (e) {
      console.error("Ollama summarization error:", e);
      return `[Ollama Summarization Failed] ${text.substring(0, 500)}...`;
    }
  }

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          num_ctx: numCtx,
          num_predict: numPredict,
          temperature: temperature
        }
      })
    });

    if (!res.ok) throw new Error('Ollama request failed');
    const data = await res.json();
    return data.response;
  } catch (e) {
    console.error("Ollama summarization error:", e);
    return `[Ollama Summarization Failed] ${text.substring(0, 500)}...`;
  }
}

export async function generate_final_prompt_with_ollama(
  prompt: string,
  url: string,
  model: string,
  numCtx: number = 8192,
  numPredict: number = 2048,
  temperature: number = 0.5
): Promise<string> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('ollama_generate', {
      url,
      model,
      prompt,
      numCtx,
      numPredict,
      temperature
    });
  }

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          num_ctx: numCtx,
          num_predict: numPredict,
          temperature: temperature
        }
      })
    });

    if (!res.ok) throw new Error('Ollama request failed');
    const data = await res.json();
    return data.response;
  } catch (e: any) {
    console.error("Ollama generation error:", e);
    throw new Error(`Ollama generation failed: ${e.message || 'Unknown error'}`);
  }
}

export async function isOllamaRunningNative(): Promise<boolean> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('is_ollama_running');
  }
  return false;
}

export async function startOllamaNative(): Promise<string> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('start_ollama');
  }
  return "Not in Tauri mode";
}

export async function stopOllamaNative(): Promise<string> {
  if (window.hasOwnProperty('__TAURI_INTERNALS__')) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke('stop_ollama');
  }
  return "Not in Tauri mode";
}
