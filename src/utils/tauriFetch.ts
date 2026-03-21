export const tauriFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Tauri support removed for web version. See CHANGELOG_WEB_TO_WIN.md
  return fetch(input, init);
};
