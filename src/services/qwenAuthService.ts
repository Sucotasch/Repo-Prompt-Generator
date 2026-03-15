import { isTauri } from '../utils/tauri';
import { tauriFetch } from '../utils/tauriFetch';

export const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
export const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
export const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(hash))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function startDeviceAuth() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const url = isTauri() ? 'https://chat.qwen.ai/api/v1/oauth2/device/code' : '/api/qwen/device/code';
  const body = isTauri() ? new URLSearchParams({
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString() : JSON.stringify({
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const headers = isTauri() ? {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  } : {
    'Content-Type': 'application/json',
  };

  const response = await tauriFetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error('Failed to start device authorization');
  }

  const data = await response.json();
  return { ...data, codeVerifier };
}

export async function pollDeviceToken(deviceCode: string, codeVerifier: string) {
  const url = isTauri() ? 'https://chat.qwen.ai/api/v1/oauth2/token' : '/api/qwen/device/token';
  const body = isTauri() ? new URLSearchParams({
    grant_type: QWEN_OAUTH_GRANT_TYPE,
    client_id: QWEN_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  }).toString() : JSON.stringify({
    grant_type: QWEN_OAUTH_GRANT_TYPE,
    client_id: QWEN_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  });

  const headers = isTauri() ? {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  } : {
    'Content-Type': 'application/json',
  };

  const response = await tauriFetch(url, {
    method: 'POST',
    headers,
    body,
  });

  const data = await response.json();
  
  if (!response.ok) {
    if (response.status === 400 && data.error === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (response.status === 429 && data.error === 'slow_down') {
      return { status: 'pending', slowDown: true };
    }
    throw new Error(data.error_description || data.error || 'Failed to poll token');
  }

  return { status: 'success', data };
}
