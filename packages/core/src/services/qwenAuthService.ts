import { isTauri } from "../utils/tauriAdapter.ts";
import { invoke } from "@tauri-apps/api/core";

export const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
export const QWEN_OAUTH_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateCodeChallenge(
  codeVerifier: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await window.crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(hash))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function startDeviceAuth() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  try {
    if (isTauri()) {
      const data = await invoke<any>("qwen_device_code", {
        clientId: QWEN_OAUTH_CLIENT_ID,
        scope: QWEN_OAUTH_SCOPE,
        codeChallenge: codeChallenge,
      });
      return { ...data, codeVerifier };
    }

    const response = await fetch("/api/qwen/device/code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: QWEN_OAUTH_CLIENT_ID,
        scope: QWEN_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return { ...data, codeVerifier };
  } catch (e: any) {
    throw new Error(`Failed to start device authorization: ${e}`);
  }
}

export async function pollDeviceToken(
  deviceCode: string,
  codeVerifier: string,
) {
  try {
    if (isTauri()) {
      const data = await invoke<any>("qwen_poll_token", {
        clientId: QWEN_OAUTH_CLIENT_ID,
        deviceCode: deviceCode,
        codeVerifier: codeVerifier,
      });

      const status = data.http_status;
      if (status === 400 && data.error === "authorization_pending") {
        return { status: "pending" };
      }
      if (status === 429 && data.error === "slow_down") {
        return { status: "pending", slowDown: true };
      }
      if (status && status >= 400) {
        throw new Error(
          data.error_description || data.error || "Failed to poll token",
        );
      }

      return { status: "success", data };
    }

    const response = await fetch("/api/qwen/device/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: QWEN_OAUTH_CLIENT_ID,
        grant_type: QWEN_OAUTH_GRANT_TYPE,
        device_code: deviceCode,
        code_verifier: codeVerifier,
      }),
    });

    const data = await response.json();

    if (response.status === 400 && data.error === "authorization_pending") {
      return { status: "pending" };
    }
    if (response.status === 429 && data.error === "slow_down") {
      return { status: "pending", slowDown: true };
    }
    if (!response.ok) {
      throw new Error(
        data.error_description || data.error || "Failed to poll token",
      );
    }

    return { status: "success", data };
  } catch (e: any) {
    throw e;
  }
}
