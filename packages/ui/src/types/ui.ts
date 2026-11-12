export type WorkbenchTab = "source" | "provider" | "rag" | "output";
export type LocalEngineType = "ollama" | "lmstudio" | "llamacpp";

export interface SavedTemplate {
  id: string;
  name: string;
  content: string;
}

export interface AttachedDoc {
  name: string;
  content: string;
}

export interface OptimizedQueryInfo {
  query: string;
  intent: string;
}

export interface TokenWarningState {
  inputTokens: number;
  availableTokens: number;
  requestedTokens: number;
  promptText: string;
}
