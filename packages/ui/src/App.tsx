import { useState } from "react";
import { isTauri } from "@repo-prompt-generator/core";
import { OutputPane } from "./components/OutputPane";
import { ProviderSettingsTab } from "./components/ProviderSettingsTab";
import { RagLocalTab } from "./components/RagLocalTab";
import { SourceTaskTab } from "./components/SourceTaskTab";
import { TokenWarningModal } from "./components/TokenWarningModal";
import { TopBar } from "./components/TopBar";
import { useAppSettings } from "./hooks/useAppSettings";
import { useGenerationPipeline } from "./hooks/useGenerationPipeline";
import { WorkbenchTab } from "./types/ui";

export default function App() {
  const settings = useAppSettings();
  const pipeline = useGenerationPipeline(settings);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("source");

  const effectiveLeftTab: Exclude<WorkbenchTab, "output"> =
    activeTab === "output" ? "source" : activeTab;

  const triggerGenerate = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setActiveTab("output");
    }
    void pipeline.handleGenerate();
  };

  const sourceLabel =
    settings.inputMode === "github"
      ? settings.url.trim() || "GitHub URL not set"
      : isTauri()
        ? settings.nativeLocalPath || "No folder selected"
        : settings.localFiles && settings.localFiles.length > 0
          ? `${settings.localFiles.length} local files`
          : "No folder selected";

  const providerLabel = settings.useOllamaForFinal
    ? `Local (${settings.localEngine}: ${settings.ollamaModel})`
    : settings.aiProvider === "gemini"
      ? `${settings.geminiModel} (${settings.geminiThinkingLevel})`
      : `Custom (${settings.customModel || "unset"})`;

  const ragLabel = [
    settings.useRag ? `Hybrid RAG (Top ${settings.ragTopK})` : "RAG Off",
    settings.aiProvider === "gemini" &&
    !settings.useOllamaForFinal &&
    settings.isDeepAnalysis
      ? "Agentic Deep Analysis"
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="h-screen flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900 overflow-hidden">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        loading={pipeline.loading}
        canGenerate={pipeline.canGenerate}
        isRegenerateCached={pipeline.isRegenerateCached}
        hasPrompt={Boolean(pipeline.prompt)}
        hasError={Boolean(pipeline.error)}
        onGenerate={triggerGenerate}
        onCancel={pipeline.cancelGeneration}
      />

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12">
        {/* Left Config Pane (5/12 on desktop, hidden below lg when Output tab selected) */}
        <section
          className={`lg:col-span-5 h-full min-h-0 overflow-y-auto bg-white lg:border-r border-slate-200 ${
            activeTab === "output" ? "hidden lg:block" : "block"
          }`}
        >
          {effectiveLeftTab === "source" && (
            <SourceTaskTab
              settings={settings}
              loading={pipeline.loading}
              onPickNativeFolder={pipeline.handlePickNativeFolder}
              onError={pipeline.setError}
              onStatus={pipeline.setStatus}
            />
          )}
          {effectiveLeftTab === "provider" && (
            <ProviderSettingsTab
              settings={settings}
              loading={pipeline.loading}
            />
          )}
          {effectiveLeftTab === "rag" && (
            <RagLocalTab
              settings={settings}
              loading={pipeline.loading}
              onStatus={pipeline.setStatus}
            />
          )}
        </section>

        {/* Right Output Pane (7/12 always visible on desktop, active tab below lg) */}
        <section
          className={`lg:col-span-7 h-full min-h-0 flex flex-col ${
            activeTab === "output" ? "flex" : "hidden lg:flex"
          }`}
        >
          <OutputPane
            loading={pipeline.loading}
            status={pipeline.status}
            error={pipeline.error}
            onDismissError={() => pipeline.setError(null)}
            isTruncated={pipeline.isTruncated}
            ragWarning={pipeline.ragWarning}
            onDismissRagWarning={() => pipeline.setRagWarning(null)}
            maxFiles={settings.maxFiles}
            prompt={pipeline.prompt}
            generatedFileName={pipeline.generatedFileName}
            usedModel={pipeline.usedModel}
            lastOptimizedQuery={pipeline.lastOptimizedQuery}
            copied={pipeline.copied}
            onCopy={pipeline.handleCopy}
            onDownload={pipeline.handleDownload}
            summaryInfo={{
              sourceLabel,
              templateLabel: settings.templateMode,
              providerLabel,
              ragLabel,
            }}
          />
        </section>
      </main>

      <TokenWarningModal
        tokenWarning={pipeline.tokenWarning}
        ollamaNumCtx={settings.ollamaNumCtx}
        onResolve={pipeline.tokenWarningResolver}
      />
    </div>
  );
}
