import { AlertTriangle, Check } from "lucide-react";
import {
  AIProvider,
  GEMINI_MODELS,
  GEMINI_MODEL_LIST,
  GeminiModelId,
  GeminiThinkingLevel,
  isTauri,
} from "@repo-prompt-generator/core";
import { useAppSettings } from "../hooks/useAppSettings";

interface ProviderSettingsTabProps {
  settings: ReturnType<typeof useAppSettings>;
  loading: boolean;
}

const THINKING_LEVELS: GeminiThinkingLevel[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "XHIGH",
];

export function ProviderSettingsTab({
  settings,
  loading,
}: ProviderSettingsTabProps) {
  const currentSpec = GEMINI_MODELS[settings.geminiModel];

  return (
    <div className="divide-y divide-slate-200">
      {/* Provider Switcher */}
      <section className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Synthesis Provider
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => settings.setAiProvider("gemini" as AIProvider)}
            disabled={loading}
            className={`px-3 py-2 text-xs font-semibold rounded-md border text-left transition-colors cursor-pointer ${
              settings.aiProvider === "gemini"
                ? "border-indigo-600 bg-indigo-50/70 text-indigo-900"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <div>Google Gemini 4</div>
            <div className="text-[11px] font-normal text-slate-500 mt-0.5">
              Tool-calling & thinking levels
            </div>
          </button>

          <button
            type="button"
            onClick={() => settings.setAiProvider("custom" as AIProvider)}
            disabled={loading}
            className={`px-3 py-2 text-xs font-semibold rounded-md border text-left transition-colors cursor-pointer ${
              settings.aiProvider === "custom"
                ? "border-indigo-600 bg-indigo-50/70 text-indigo-900"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <div>Custom OpenAI API</div>
            <div className="text-[11px] font-normal text-slate-500 mt-0.5">
              OpenRouter, Groq, xAI, NIM
            </div>
          </button>
        </div>
      </section>

      {settings.aiProvider === "gemini" ? (
        <>
          {/* Gemini 4 Model & Reasoning */}
          <section className="p-5 space-y-4">
            <div>
              <label
                htmlFor="geminiModel"
                className="block text-xs font-medium text-slate-600 mb-1"
              >
                Gemini Model
              </label>
              <select
                id="geminiModel"
                value={settings.geminiModel}
                onChange={(e) =>
                  settings.setGeminiModel(e.target.value as GeminiModelId)
                }
                disabled={loading}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {GEMINI_MODEL_LIST.map((spec) => (
                  <option key={spec.id} value={spec.id}>
                    {spec.label} ({spec.id})
                    {spec.requiresPaidKey ? " — Paid API Key" : " — Default"}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-slate-500">
                {currentSpec.description}
                {currentSpec.requiresPaidKey && (
                  <span className="text-amber-700 font-medium">
                    {" "}
                    · Requires paid Gemini API key
                  </span>
                )}
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-600">
                  Thinking Level
                </label>
                <span className="text-[11px] font-mono text-slate-500">
                  {settings.geminiThinkingLevel}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {THINKING_LEVELS.map((level) => {
                  const supported =
                    currentSpec.supportedThinkingLevels.includes(level);
                  const active = settings.geminiThinkingLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      disabled={loading || !supported}
                      onClick={() => settings.setGeminiThinkingLevel(level)}
                      title={
                        supported
                          ? `Set thinking level to ${level}`
                          : `${level} is only supported on gemini-4-hydrogen`
                      }
                      className={`px-2 py-1.5 text-xs font-mono font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                        active
                          ? "border-slate-900 bg-slate-900 text-white"
                          : supported
                            ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                            : "border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed"
                      }`}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Gemini 4 controls reasoning depth natively via ThinkingLevel
                (no manual temperature override needed).
              </p>
            </div>

            <div className="pt-1">
              <label
                className={`flex items-start gap-2.5 ${
                  settings.useOllamaForFinal
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={settings.isDeepAnalysis}
                  onChange={(e) =>
                    settings.setIsDeepAnalysis(e.target.checked)
                  }
                  disabled={loading || settings.useOllamaForFinal}
                  className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded"
                />
                <div className="text-xs leading-relaxed">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">
                      Agentic RAG (Deep Analysis)
                    </span>
                    <span className="text-[11px] font-semibold font-mono text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                      Token x 3
                    </span>
                  </div>
                  <p className="text-slate-500 mt-0.5">
                    Allows Gemini to request up to 5 extra files per round (up
                    to 3 API turns with full accumulated context, multiplying
                    token consumption by ~3x or more).
                    {settings.useOllamaForFinal &&
                      " Disabled while Local Final Generation is enabled."}
                  </p>
                </div>
              </label>
            </div>
          </section>

          {/* Gemini Credentials & Runtime */}
          <section className="p-5 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {isTauri()
                ? "Desktop API & Network"
                : "API Key Configuration"}
            </h3>

            {isTauri() ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Gemini API Key (Optional if set in environment)
                  </label>
                  <input
                    type="password"
                    name="gemini-api-key"
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    value={settings.geminiApiKey}
                    onChange={(e) => settings.setGeminiApiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    disabled={loading}
                    className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  {settings.keySourceInfo && (
                    <p className="mt-1 text-[11px] text-slate-500">
                      Status: {settings.keySourceInfo}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Global HTTP/SOCKS Proxy (Optional)
                  </label>
                  <input
                    type="text"
                    value={settings.proxyAddress}
                    onChange={(e) => settings.setProxyAddress(e.target.value)}
                    placeholder="http://127.0.0.1:10809"
                    disabled={loading}
                    className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Web mode routes all Gemini requests through the server proxy
                  using <code className="font-mono text-slate-800">GEMINI_API_KEY</code>.
                </p>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    BYOK API Key Override (Optional, paid keys for Argon/Carbon)
                  </label>
                  <input
                    type="password"
                    name="gemini-byok-override"
                    autoComplete="new-password"
                    data-1p-ignore="true"
                    data-lpignore="true"
                    value={settings.geminiApiKey}
                    onChange={(e) => settings.setGeminiApiKey(e.target.value)}
                    placeholder="Leave empty to use server key..."
                    disabled={loading}
                    className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>
            )}
          </section>
        </>
      ) : (
        /* Custom OpenAI-Compatible Provider */
        <section className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Custom Endpoint
            </h3>
            <select
              className="text-xs border border-slate-300 rounded-md px-2 py-1 bg-white text-slate-700"
              onChange={(e) => {
                if (e.target.value) {
                  settings.setCustomBaseUrl(e.target.value);
                  settings.setCustomProviderConnected(null);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>
                Load Preset...
              </option>
              <option value="https://openrouter.ai/api/v1">OpenRouter</option>
              <option value="https://integrate.api.nvidia.com/v1">
                NVIDIA NIM
              </option>
              <option value="https://api.groq.com/openai/v1">Groq</option>
              <option value="https://api.x.ai/v1">xAI (Grok)</option>
              <option value="https://models.inference.ai.azure.com">
                GitHub Models
              </option>
              <option value="https://api.mistral.ai/v1">Mistral</option>
              <option value="https://api.cerebras.ai/v1">Cerebras</option>
              <option value="https://api.moonshot.cn/v1">
                Kimi (Moonshot)
              </option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Base URL
            </label>
            <input
              type="text"
              value={settings.customBaseUrl}
              onChange={(e) => {
                settings.setCustomBaseUrl(e.target.value);
                settings.setCustomProviderConnected(null);
              }}
              placeholder="https://api.groq.com/openai/v1"
              disabled={loading}
              className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              API Key
            </label>
            <input
              type="password"
              name="custom-provider-api-key"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              value={settings.customApiKey}
              onChange={(e) => {
                settings.setCustomApiKey(e.target.value);
                settings.setCustomProviderConnected(null);
              }}
              placeholder="sk-..."
              disabled={loading}
              className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Model Name
              </label>
              <input
                type="text"
                list="custom-models-list"
                value={settings.customModel}
                onChange={(e) => settings.setCustomModel(e.target.value)}
                placeholder="e.g., llama-3.3-70b-versatile"
                disabled={loading}
                className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {settings.availableCustomModels.length > 0 && (
                <datalist id="custom-models-list">
                  {settings.availableCustomModels
                    .filter((m) =>
                      m
                        .toLowerCase()
                        .includes(settings.customModel.toLowerCase()),
                    )
                    .slice(0, 300)
                    .map((m) => (
                      <option key={m} value={m} />
                    ))}
                </datalist>
              )}
            </div>
            <button
              type="button"
              onClick={settings.handleTestCustomProvider}
              disabled={settings.testingCustomProvider || loading}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {settings.testingCustomProvider ? "Fetching..." : "Fetch Models"}
            </button>
          </div>

          {settings.customProviderConnected === true && (
            <p className="text-xs text-emerald-700 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> Connected (
              {settings.availableCustomModels.length} models loaded)
            </p>
          )}
          {settings.customProviderConnected === false && (
            <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {settings.customProviderError || "Check URL and API Key."}
              </span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-600">
                Temperature
              </label>
              <span className="text-xs font-mono tabular-nums text-slate-700">
                {settings.ollamaTemperature.toFixed(1)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={settings.ollamaTemperature}
              onChange={(e) =>
                settings.setOllamaTemperature(Number(e.target.value))
              }
              disabled={loading}
              className="w-full accent-indigo-600 cursor-pointer"
            />
          </div>
        </section>
      )}

      {/* Context Size & File Truncation Limit */}
      <section className="p-5 space-y-2">
        <label
          htmlFor="fileTruncationLimit"
          className="block text-xs font-medium text-slate-600"
        >
          Per-File Truncation Limit (Characters, 0 = Full Files)
        </label>
        <input
          id="fileTruncationLimit"
          type="number"
          min={0}
          step={1000}
          value={settings.fileTruncationLimit}
          onChange={(e) =>
            settings.setFileTruncationLimit(
              Math.max(0, Number(e.target.value)),
            )
          }
          disabled={loading}
          className="w-full max-w-[240px] px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <p className="text-[11px] text-slate-500">
          Set to 0 to pass full source files; use 2000–4000 for smaller-context
          custom endpoints or faster runs.
        </p>
      </section>
    </div>
  );
}
