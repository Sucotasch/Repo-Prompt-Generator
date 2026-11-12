import { Check, Download, Trash2 } from "lucide-react";
import {
  EmbeddingCacheService,
  isTauri,
} from "@repo-prompt-generator/core";
import { useAppSettings } from "../hooks/useAppSettings";
import { LocalEngineType } from "../types/ui";

interface RagLocalTabProps {
  settings: ReturnType<typeof useAppSettings>;
  loading: boolean;
  onStatus: (msg: string) => void;
}

export function RagLocalTab({
  settings,
  loading,
  onStatus,
}: RagLocalTabProps) {
  const handleEngineChange = (newEngine: LocalEngineType) => {
    settings.setLocalEngine(newEngine);
    if (
      settings.ollamaUrl === "http://localhost:11434" ||
      settings.ollamaUrl === "http://localhost:1234/v1" ||
      settings.ollamaUrl === "http://localhost:8080/v1" ||
      settings.ollamaUrl === "http://127.0.0.1:11434" ||
      settings.ollamaUrl === "http://127.0.0.1:1234/v1" ||
      settings.ollamaUrl === "http://127.0.0.1:8080/v1"
    ) {
      if (newEngine === "ollama")
        settings.setOllamaUrl("http://localhost:11434");
      else if (newEngine === "lmstudio")
        settings.setOllamaUrl("http://localhost:1234/v1");
      else if (newEngine === "llamacpp")
        settings.setOllamaUrl("http://localhost:8080/v1");
    }
    settings.setOllamaConnected(null);
  };

  const needsLocalGenerationConfig =
    settings.useOllama ||
    settings.useOllamaForFinal ||
    settings.useOllamaForQueryExpansion;

  return (
    <div className="divide-y divide-slate-200">
      {/* Pinned Top Connection Header (zero scrolling required) */}
      <section className="p-5 bg-slate-50/70 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Local Engine Connection
          </h2>
          {settings.ollamaConnected === true && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Check className="w-3.5 h-3.5" />
              <span>Connected</span>
            </span>
          )}
          {settings.ollamaConnected === false && (
            <span className="text-xs font-medium text-red-600">
              {isTauri()
                ? "Connection failed"
                : "Connection failed (check CORS/server)"}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
          <div className="sm:col-span-4">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Engine
            </label>
            <select
              value={settings.localEngine}
              onChange={(e) =>
                handleEngineChange(e.target.value as LocalEngineType)
              }
              disabled={loading}
              className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="ollama">Ollama (Native)</option>
              <option value="lmstudio">LM Studio</option>
              <option value="llamacpp">llama.cpp</option>
            </select>
          </div>

          <div className="sm:col-span-5">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Endpoint URL
            </label>
            <input
              type="text"
              value={settings.ollamaUrl}
              onChange={(e) => {
                settings.setOllamaUrl(e.target.value);
                settings.setOllamaConnected(null);
              }}
              disabled={loading}
              placeholder={
                settings.localEngine === "ollama"
                  ? "http://localhost:11434"
                  : "http://localhost:1234/v1"
              }
              className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="sm:col-span-3">
            <button
              type="button"
              onClick={settings.handleTestLocalEngine}
              disabled={settings.testingOllama || loading}
              className="w-full px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 transition-colors h-[34px]"
            >
              {settings.testingOllama ? "Testing..." : "Test Connection"}
            </button>
          </div>
        </div>

        {/* Ollama Daemon Control / Web Helper */}
        {settings.localEngine === "ollama" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-600">
            {isTauri() ? (
              <>
                <span>
                  Native Ollama process:{" "}
                  <strong className="text-slate-800">
                    {settings.ollamaNativeRunning ? "Running" : "Stopped"}
                  </strong>
                </span>
                {!settings.ollamaNativeRunning ? (
                  <button
                    type="button"
                    onClick={settings.handleStartOllama}
                    disabled={settings.ollamaNativeLoading}
                    className="px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {settings.ollamaNativeLoading
                      ? "Starting..."
                      : "Start Ollama"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={settings.handleStopOllama}
                    disabled={settings.ollamaNativeLoading}
                    className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {settings.ollamaNativeLoading
                      ? "Stopping..."
                      : "Stop Ollama"}
                  </button>
                )}
              </>
            ) : (
              <>
                <span className="truncate">
                  Requires{" "}
                  <code className="font-mono text-slate-800">
                    OLLAMA_ORIGINS="{window.location.origin}"
                  </code>
                </span>
                <button
                  type="button"
                  onClick={settings.handleDownloadBat}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-white border border-indigo-200 rounded hover:bg-indigo-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Windows .bat</span>
                </button>
              </>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">
            Start{" "}
            {settings.localEngine === "lmstudio" ? "LM Studio" : "llama.cpp"}{" "}
            server externally
            {!isTauri() ? " with CORS enabled" : ""} and click Test Connection.
          </p>
        )}
      </section>

      {/* Workflow Toggles */}
      <section className="p-5 space-y-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Local & RAG Pipeline Modes
        </h3>
        <label className="flex items-center gap-2.5 text-xs font-medium text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.useRag}
            onChange={(e) => settings.setUseRag(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded"
          />
          <span>Use Hybrid RAG (Semantic + BM25 Context Filter)</span>
        </label>
        <label className="flex items-center gap-2.5 text-xs font-medium text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.useOllama}
            onChange={(e) => settings.setUseOllama(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded"
          />
          <span>Use Local Pre-summarization (Compress files locally)</span>
        </label>
        <label className="flex items-center gap-2.5 text-xs font-medium text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.useOllamaForFinal}
            onChange={(e) => settings.setUseOllamaForFinal(e.target.checked)}
            disabled={loading}
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded"
          />
          <span>Use Local Model for Final Generation (Bypass Cloud API)</span>
        </label>
      </section>

      {/* RAG Core & Advanced Settings (immediately visible, zero burrowing) */}
      {settings.useRag && (
        <section className="p-5 space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            RAG Retrieval & Advanced Controls
          </h3>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Target Components (RAG Search Query)
            </label>
            <input
              type="text"
              value={settings.ragQuery}
              onChange={(e) => settings.setRagQuery(e.target.value)}
              disabled={loading}
              placeholder="e.g., auth middleware, database schema, billing webhooks (empty = auto)"
              className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Embedding Model (Required)
              </label>
              {settings.availableModels.length > 0 ? (
                <select
                  value={settings.ragModel}
                  onChange={(e) => settings.setRagModel(e.target.value)}
                  disabled={loading}
                  className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="" disabled>
                    Select an embedding model...
                  </option>
                  {settings.availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={settings.ragModel}
                  onChange={(e) => settings.setRagModel(e.target.value)}
                  disabled={loading}
                  placeholder="nomic-embed-text"
                  className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Top K Chunks (1–50)
              </label>
              <input
                type="number"
                min={1}
                max={50}
                value={settings.ragTopK}
                onChange={(e) => settings.setRagTopK(Number(e.target.value))}
                disabled={loading}
                className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-600">
                  Search Strategy
                </label>
                <span className="text-[11px] font-mono tabular-nums text-slate-600">
                  {settings.ragSearchStrategy < 0.4
                    ? "Exploration"
                    : settings.ragSearchStrategy > 0.6
                      ? "Precision"
                      : "Balanced"}{" "}
                  ({settings.ragSearchStrategy.toFixed(1)})
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={settings.ragSearchStrategy}
                onChange={(e) =>
                  settings.setRagSearchStrategy(parseFloat(e.target.value))
                }
                disabled={loading}
                className="w-full accent-indigo-600 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-wider">
                <span>Semantic</span>
                <span>Exact BM25</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-600">
                  Chunk Size (Lines)
                </label>
                <span className="text-[11px] font-mono tabular-nums text-slate-600">
                  {settings.ragChunkSize}
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                step="5"
                value={settings.ragChunkSize}
                onChange={(e) =>
                  settings.setRagChunkSize(Number(e.target.value))
                }
                disabled={loading}
                className="w-full accent-indigo-600 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-slate-400 uppercase tracking-wider">
                <span>Fine (10)</span>
                <span>Coarse (100)</span>
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.useQueryExpansion}
                onChange={(e) =>
                  settings.setUseQueryExpansion(e.target.checked)
                }
                className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded"
              />
              <span>AI Query Expansion (expands query with technical terms)</span>
            </label>

            {settings.useQueryExpansion && (
              <label className="flex items-center gap-2 pl-5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.useOllamaForQueryExpansion}
                  onChange={(e) =>
                    settings.setUseOllamaForQueryExpansion(e.target.checked)
                  }
                  className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded"
                />
                <span>Use Local Model for Query Expansion</span>
              </label>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.useIntentReranking}
                onChange={(e) =>
                  settings.setUseIntentReranking(e.target.checked)
                }
                className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded"
              />
              <span>Intent-Aware Reranking (boosts files by task intent)</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1 border-t border-slate-100">
            <button
              type="button"
              onClick={() => {
                let count = 0;
                const keysToRemove: string[] = [];
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i);
                  if (key && key.startsWith("rag_opt_")) {
                    keysToRemove.push(key);
                  }
                }
                keysToRemove.forEach((key) => {
                  localStorage.removeItem(key);
                  count++;
                });
                onStatus(`Cleared ${count} cached RAG queries.`);
                setTimeout(() => onStatus(""), 3000);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear RAG Query Cache</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                onStatus("Clearing embedding cache...");
                await EmbeddingCacheService.clearCache();
                onStatus("Embedding cache cleared.");
                setTimeout(() => onStatus(""), 3000);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-800 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Embedding Cache</span>
            </button>
          </div>
        </section>
      )}

      {/* Local LLM Generation Parameters */}
      {needsLocalGenerationConfig && (
        <section className="p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Local LLM Generation Parameters
          </h3>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Local LLM Model Name
            </label>
            {settings.availableModels.length > 0 ? (
              <select
                value={settings.ollamaModel}
                onChange={(e) => settings.setOllamaModel(e.target.value)}
                disabled={loading}
                className="w-full px-2.5 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {settings.availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={settings.ollamaModel}
                onChange={(e) => settings.setOllamaModel(e.target.value)}
                disabled={loading}
                placeholder="llama3"
                className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {settings.localEngine === "ollama" && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Context Window
                </label>
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  value={settings.ollamaNumCtx}
                  onChange={(e) =>
                    settings.setOllamaNumCtx(Number(e.target.value))
                  }
                  disabled={loading}
                  className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Summary Max Tokens
              </label>
              <input
                type="number"
                min={50}
                step={50}
                value={settings.ollamaSummaryPredict}
                onChange={(e) =>
                  settings.setOllamaSummaryPredict(Number(e.target.value))
                }
                disabled={loading}
                className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Final Max Tokens
              </label>
              <input
                type="number"
                min={250}
                step={50}
                value={settings.ollamaFinalPredict}
                onChange={(e) =>
                  settings.setOllamaFinalPredict(Number(e.target.value))
                }
                disabled={loading}
                className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-600">
                Local Temperature
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
    </div>
  );
}
