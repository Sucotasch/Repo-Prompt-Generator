export type GeminiModelId =
  | "gemini-4-hydrogen"
  | "gemini-4-argon"
  | "gemini-4-carbon";

export type GeminiThinkingLevel = "LOW" | "MEDIUM" | "HIGH" | "XHIGH";

export interface GeminiModelSpec {
  id: GeminiModelId;
  label: string;
  description: string;
  requiresPaidKey: boolean;
  defaultThinkingLevel: GeminiThinkingLevel;
  supportedThinkingLevels: readonly GeminiThinkingLevel[];
}

export const DEFAULT_GEMINI_MODEL: GeminiModelId = "gemini-4-hydrogen";

export const GEMINI_MODELS: Record<GeminiModelId, GeminiModelSpec> = {
  "gemini-4-hydrogen": {
    id: "gemini-4-hydrogen",
    label: "Gemini 4 Hydrogen",
    description: "Fast default model & XHIGH agentic workflows",
    requiresPaidKey: false,
    defaultThinkingLevel: "HIGH",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
  },
  "gemini-4-argon": {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    description: "Complex coding, STEM, and multi-module synthesis",
    requiresPaidKey: true,
    defaultThinkingLevel: "MEDIUM",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"],
  },
  "gemini-4-carbon": {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    description: "Deep architectural, root-cause, and security reasoning",
    requiresPaidKey: true,
    defaultThinkingLevel: "MEDIUM",
    supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"],
  },
};

export const GEMINI_MODEL_LIST: GeminiModelSpec[] = [
  GEMINI_MODELS["gemini-4-hydrogen"],
  GEMINI_MODELS["gemini-4-argon"],
  GEMINI_MODELS["gemini-4-carbon"],
];

export function isValidGeminiModel(model: unknown): model is GeminiModelId {
  return (
    typeof model === "string" &&
    Object.prototype.hasOwnProperty.call(GEMINI_MODELS, model)
  );
}

export function resolveGeminiModel(model?: string): GeminiModelId {
  return isValidGeminiModel(model) ? model : DEFAULT_GEMINI_MODEL;
}

export function normalizeThinkingLevel(
  model: GeminiModelId,
  requested?: string,
): GeminiThinkingLevel {
  const spec = GEMINI_MODELS[model] ?? GEMINI_MODELS[DEFAULT_GEMINI_MODEL];
  if (
    requested &&
    (spec.supportedThinkingLevels as readonly string[]).includes(requested)
  ) {
    return requested as GeminiThinkingLevel;
  }
  if (requested === "XHIGH") {
    return "HIGH";
  }
  return spec.defaultThinkingLevel;
}
