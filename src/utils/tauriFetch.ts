import { isTauri } from './tauri';

export const tauriFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (isTauri()) {
    const { fetch: pluginFetch } = await import('@tauri-apps/plugin-http');
    // @ts-ignore - pluginFetch signature is slightly different but compatible for basic use cases
    return pluginFetch(input.toString(), init);
  }
  return fetch(input, init);
};
