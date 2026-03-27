import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauriAdapter.ts";

export const tauriFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (isTauri()) {
    const url = input.toString();
    const method = init?.method || "GET";
    const headers = (init?.headers as Record<string, string>) || {};
    const body = init?.body ? String(init.body) : null;

    try {
      const response = await invoke<any>("ai_network_request", {
        method,
        url,
        headers,
        body,
      });

      return new Response(response.text, {
        status: response.status,
        headers: response.headers,
      });
    } catch (e: any) {
      throw new Error(`Tauri fetch error: ${e}`);
    }
  }

  return fetch(input, init);
};

