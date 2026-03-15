export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
};

export const invokeTauri = async <T>(cmd: string, args?: any): Promise<T | null> => {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.error(`Tauri invoke error (${cmd}):`, e);
    throw e;
  }
};
