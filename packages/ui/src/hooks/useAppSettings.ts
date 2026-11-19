import React, { useState, useEffect } from "react";
import {
  AIProvider,
  GeminiModelId,
  GeminiThinkingLevel,
  checkOllamaConnection,
  fetchOllamaModels,
  fetchOpenAICompatibleModels,
  getTemplate,
  isOllamaRunningNative,
  isTauri,
  normalizeThinkingLevel,
  resolveGeminiModel,
  startOllamaNative,
  stopOllamaNative,
  tauriInvoke,
} from "@repo-prompt-generator/core";
import { AttachedDoc, LocalEngineType, SavedTemplate } from "../types/ui";

export function useAppSettings() {
  const initialSettings = (() => {
    try {
      const saved = localStorage.getItem("gemini_app_settings");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  })();

  const [url, setUrl] = useState("");
  const [githubToken, setGithubToken] = useState<string>(
    initialSettings.githubToken || "",
  );
  const [maxFiles, setMaxFiles] = useState<number>(
    initialSettings.maxFiles || 5,
  );
  const [inputMode, setInputMode] = useState<"github" | "local">(
    initialSettings.inputMode || "github",
  );
  const [localFiles, setLocalFiles] = useState<FileList | null>(null);
  const [nativeLocalPath, setNativeLocalPath] = useState<string>("");

  // Reference Repository State
  const [referenceInputMode, setReferenceInputMode] = useState<
    "github" | "local"
  >("github");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceLocalFiles, setReferenceLocalFiles] =
    useState<FileList | null>(null);
  const [referenceNativeLocalPath, setReferenceNativeLocalPath] =
    useState<string>("");
  const [referenceMaxFiles, setReferenceMaxFiles] = useState<number>(
    initialSettings.maxFiles || 5,
  );
  const [useReferenceRepo, setUseReferenceRepo] = useState(false);

  // Templates & Task Context
  const [templateMode, setTemplateMode] = useState<string>("default");
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    try {
      const saved = localStorage.getItem("gemini_custom_templates");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [customInstruction, setCustomInstruction] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [ragQuery, setRagQuery] = useState("");
  const [attachedDocs, setAttachedDocs] = useState<AttachedDoc[]>([]);
  const [analyzeIssues, setAnalyzeIssues] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [isSavingNew, setIsSavingNew] = useState(false);
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<
    string | null
  >(null);

  // Provider & Gemini 4 State
  const [aiProvider, setAiProvider] = useState<AIProvider>(
    initialSettings.aiProvider || "gemini",
  );
  const initialResolvedModel = resolveGeminiModel(initialSettings.geminiModel);
  const [geminiModel, setGeminiModelState] =
    useState<GeminiModelId>(initialResolvedModel);
  const [geminiThinkingLevel, setGeminiThinkingLevel] =
    useState<GeminiThinkingLevel>(() =>
      normalizeThinkingLevel(
        initialResolvedModel,
        initialSettings.geminiThinkingLevel,
      ),
    );
  const [geminiApiKey, setGeminiApiKey] = useState<string>(
    initialSettings.geminiApiKey || "",
  );
  const [proxyAddress, setProxyAddress] = useState<string>(
    initialSettings.proxyAddress || "",
  );
  const [keySourceInfo, setKeySourceInfo] = useState<string>("");

  const setGeminiModel = (nextModel: GeminiModelId) => {
    setGeminiModelState(nextModel);
    setGeminiThinkingLevel((prev) => normalizeThinkingLevel(nextModel, prev));
  };

  // Custom Provider State
  const [customBaseUrl, setCustomBaseUrl] = useState<string>(
    initialSettings.customBaseUrl || "",
  );
  const [customApiKey, setCustomApiKey] = useState<string>(
    initialSettings.customApiKey || "",
  );
  const [customModel, setCustomModel] = useState<string>(
    initialSettings.customModel || "",
  );
  const [availableCustomModels, setAvailableCustomModels] = useState<string[]>(
    [],
  );
  const [testingCustomProvider, setTestingCustomProvider] = useState(false);
  const [customProviderConnected, setCustomProviderConnected] = useState<
    boolean | null
  >(null);
  const [customProviderError, setCustomProviderError] = useState<string | null>(
    null,
  );

  // RAG & Local Engine State
  const [useOllama, setUseOllama] = useState<boolean>(
    initialSettings.useOllama || false,
  );
  const [useOllamaForFinal, setUseOllamaForFinal] = useState<boolean>(
    initialSettings.useOllamaForFinal || false,
  );
  const [localEngine, setLocalEngine] = useState<LocalEngineType>(
    initialSettings.localEngine || "ollama",
  );
  const [useRag, setUseRag] = useState<boolean>(
    initialSettings.useRag || false,
  );
  const [isDeepAnalysis, setIsDeepAnalysis] = useState<boolean>(
    initialSettings.isDeepAnalysis || false,
  );
  const [ragModel, setRagModel] = useState<string>(
    initialSettings.ragModel || "",
  );
  const [ragTopK, setRagTopK] = useState<number>(initialSettings.ragTopK || 10);
  const [ragChunkSize, setRagChunkSize] = useState<number>(
    initialSettings.ragChunkSize || 30,
  );
  const [ragSearchStrategy, setRagSearchStrategy] = useState<number>(
    initialSettings.ragSearchStrategy !== undefined
      ? initialSettings.ragSearchStrategy
      : 0.5,
  );
  const [ollamaUrl, setOllamaUrl] = useState<string>(
    initialSettings.ollamaUrl || "http://localhost:11434",
  );
  const [ollamaModel, setOllamaModel] = useState<string>(
    initialSettings.ollamaModel || "llama3",
  );
  const [ollamaNumCtx, setOllamaNumCtx] = useState<number>(
    initialSettings.ollamaNumCtx || 8192,
  );
  const [ollamaNativeRunning, setOllamaNativeRunning] = useState(false);
  const [ollamaNativeLoading, setOllamaNativeLoading] = useState(false);
  const [ollamaSummaryPredict, setOllamaSummaryPredict] = useState<number>(
    initialSettings.ollamaSummaryPredict || 500,
  );
  const [ollamaFinalPredict, setOllamaFinalPredict] = useState<number>(
    initialSettings.ollamaFinalPredict || 2000,
  );
  const [fileTruncationLimit, setFileTruncationLimit] = useState<number>(
    initialSettings.fileTruncationLimit !== undefined
      ? initialSettings.fileTruncationLimit
      : 0,
  );
  const [ollamaTemperature, setOllamaTemperature] = useState<number>(
    initialSettings.ollamaTemperature !== undefined
      ? initialSettings.ollamaTemperature
      : 0.3,
  );
  const [useQueryExpansion, setUseQueryExpansion] = useState<boolean>(
    initialSettings.useQueryExpansion !== undefined
      ? initialSettings.useQueryExpansion
      : true,
  );
  const [useOllamaForQueryExpansion, setUseOllamaForQueryExpansion] =
    useState<boolean>(initialSettings.useOllamaForQueryExpansion || false);
  const [useIntentReranking, setUseIntentReranking] = useState<boolean>(
    initialSettings.useIntentReranking !== undefined
      ? initialSettings.useIntentReranking
      : true,
  );

  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testingOllama, setTestingOllama] = useState(false);

  // Sync native runtime info on mount
  useEffect(() => {
    if (isTauri()) {
      isOllamaRunningNative().then(setOllamaNativeRunning).catch(() => {});
      tauriInvoke<string>("get_gemini_key_source")
        .then(setKeySourceInfo)
        .catch(() => {});
    }
  }, []);

  // Auto-clear RAG query optimization cache when repo or template changes
  useEffect(() => {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("rag_opt_")) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    }
  }, [
    url,
    nativeLocalPath,
    templateMode,
    referenceUrl,
    referenceNativeLocalPath,
    useReferenceRepo,
  ]);

  // Persist settings
  useEffect(() => {
    const settings = {
      inputMode,
      githubToken,
      maxFiles,
      useOllama,
      useOllamaForFinal,
      localEngine,
      aiProvider,
      geminiModel,
      geminiThinkingLevel,
      useRag,
      isDeepAnalysis,
      ragModel,
      ragTopK,
      ragChunkSize,
      ragSearchStrategy,
      ollamaUrl,
      ollamaModel,
      ollamaNumCtx,
      ollamaSummaryPredict,
      ollamaFinalPredict,
      fileTruncationLimit,
      ollamaTemperature,
      useQueryExpansion,
      useOllamaForQueryExpansion,
      useIntentReranking,
      customBaseUrl,
      customApiKey,
      customModel,
      geminiApiKey,
      proxyAddress,
    };
    localStorage.setItem("gemini_app_settings", JSON.stringify(settings));
  }, [
    inputMode,
    githubToken,
    maxFiles,
    useOllama,
    useOllamaForFinal,
    localEngine,
    aiProvider,
    geminiModel,
    geminiThinkingLevel,
    useRag,
    isDeepAnalysis,
    ragModel,
    ragTopK,
    ragChunkSize,
    ragSearchStrategy,
    ollamaUrl,
    ollamaModel,
    ollamaNumCtx,
    ollamaSummaryPredict,
    ollamaFinalPredict,
    fileTruncationLimit,
    ollamaTemperature,
    useQueryExpansion,
    useOllamaForQueryExpansion,
    useIntentReranking,
    customBaseUrl,
    customApiKey,
    customModel,
    geminiApiKey,
    proxyAddress,
  ]);

  // Sync Tauri backend app config
  useEffect(() => {
    if (isTauri()) {
      tauriInvoke("set_app_config", {
        geminiKey: geminiApiKey,
        proxy: proxyAddress,
      })
        .then(() => tauriInvoke<string>("get_gemini_key_source"))
        .then(setKeySourceInfo)
        .catch(console.error);
    }
  }, [geminiApiKey, proxyAddress]);

  const handleTemplateChange = (mode: string) => {
    setConfirmDeleteTemplateId(null);
    setTemplateMode(mode);
    if (mode === "custom") {
      setCustomInstruction("");
    } else {
      const tpl = savedTemplates.find((t) => t.id === mode);
      if (tpl) setCustomInstruction(tpl.content);
    }
  };

  const handleSaveTemplate = (e: React.MouseEvent) => {
    e.preventDefault();
    if (templateMode.startsWith("user_")) {
      const updated = savedTemplates.map((t) =>
        t.id === templateMode ? { ...t, content: customInstruction } : t,
      );
      setSavedTemplates(updated);
      localStorage.setItem("gemini_custom_templates", JSON.stringify(updated));
    } else {
      setIsSavingNew(true);
    }
  };

  const confirmSaveTemplate = (
    e?: React.MouseEvent | React.KeyboardEvent,
  ) => {
    if (e) e.preventDefault();
    if (!newTemplateName.trim()) return;
    const newId = "user_" + Date.now();
    const newTemplates = [
      ...savedTemplates,
      { id: newId, name: newTemplateName.trim(), content: customInstruction },
    ];
    setSavedTemplates(newTemplates);
    localStorage.setItem(
      "gemini_custom_templates",
      JSON.stringify(newTemplates),
    );
    setTemplateMode(newId);
    setIsSavingNew(false);
    setNewTemplateName("");
  };

  const handleDeleteTemplate = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!templateMode.startsWith("user_")) return;
    if (confirmDeleteTemplateId !== templateMode) {
      setConfirmDeleteTemplateId(templateMode);
      return;
    }
    const updated = savedTemplates.filter((t) => t.id !== templateMode);
    setSavedTemplates(updated);
    localStorage.setItem("gemini_custom_templates", JSON.stringify(updated));
    setConfirmDeleteTemplateId(null);
    handleTemplateChange("default");
  };

  const handleExportTemplates = (onError: (msg: string | null) => void) => {
    if (savedTemplates.length === 0) {
      onError("No custom templates to export.");
      return;
    }
    onError(null);
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(savedTemplates, null, 2));
    const downloadAnchorNode = document.createElement("a");
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "gemini_custom_templates.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImportTemplates = (
    e: React.ChangeEvent<HTMLInputElement>,
    onError: (msg: string | null) => void,
    onStatus: (msg: string) => void,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) {
          const existingIds = new Set(savedTemplates.map((t) => t.id));
          const newTemplates = [...savedTemplates];
          let added = 0;
          for (const t of imported) {
            if (t.id && t.name && t.content && !existingIds.has(t.id)) {
              newTemplates.push(t);
              added++;
            }
          }
          setSavedTemplates(newTemplates);
          localStorage.setItem(
            "gemini_custom_templates",
            JSON.stringify(newTemplates),
          );
          onError(null);
          onStatus(`Successfully imported ${added} template(s).`);
          setTimeout(() => onStatus(""), 4000);
        } else {
          onError("Invalid templates file format.");
        }
      } catch {
        onError("Failed to parse templates file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleTestLocalEngine = async () => {
    setTestingOllama(true);
    let isConnected = false;
    let models: string[] = [];
    try {
      if (localEngine === "ollama") {
        isConnected = await checkOllamaConnection(ollamaUrl);
        if (isConnected) {
          models = await fetchOllamaModels(ollamaUrl);
        }
      } else {
        models = await fetchOpenAICompatibleModels(ollamaUrl, "sk-dummy-key");
        isConnected = models.length > 0;
      }
    } catch {
      isConnected = false;
    }

    setOllamaConnected(isConnected);
    if (isConnected) {
      setAvailableModels(models);
      if (models.length > 0 && !models.includes(ollamaModel)) {
        setOllamaModel(models[0]);
      }
    } else {
      setAvailableModels([]);
    }
    setTestingOllama(false);
  };

  const handleTestCustomProvider = async () => {
    if (!customBaseUrl.trim()) {
      setCustomProviderConnected(false);
      setCustomProviderError("Please enter a Base URL.");
      return;
    }
    setTestingCustomProvider(true);
    setCustomProviderError(null);
    try {
      const models = await fetchOpenAICompatibleModels(
        customBaseUrl,
        customApiKey,
      );
      setAvailableCustomModels(models);
      setCustomProviderConnected(true);
      if (models.length > 0 && customModel && !models.includes(customModel)) {
        setCustomModel("");
      }
    } catch (e: any) {
      console.error(e);
      setCustomProviderConnected(false);
      let msg = e.message || "Unknown error";
      if (msg === "Failed to fetch") {
        msg =
          "Network or CORS error. The API might block browser requests to /models. You can still type the model name manually (e.g., grok-4-latest) and try generating.";
      }
      setCustomProviderError(msg);
      setAvailableCustomModels([]);
    }
    setTestingCustomProvider(false);
  };

  const handleStartOllama = async () => {
    setOllamaNativeLoading(true);
    try {
      await startOllamaNative();
      setOllamaNativeRunning(true);
      setTimeout(() => {
        handleTestLocalEngine();
      }, 2000);
    } catch (e) {
      console.error("Failed to start Ollama", e);
    } finally {
      setOllamaNativeLoading(false);
    }
  };

  const handleStopOllama = async () => {
    setOllamaNativeLoading(true);
    try {
      await stopOllamaNative();
      setOllamaNativeRunning(false);
      setOllamaConnected(false);
    } catch (e) {
      console.error("Failed to stop Ollama", e);
    } finally {
      setOllamaNativeLoading(false);
    }
  };

  const handleDownloadBat = () => {
    const origin = window.location.origin;
    const batLines = [
      "@echo off",
      "setlocal EnableExtensions",
      "color 0A",
      "echo ==========================================",
      "echo Starting Ollama with CORS enabled...",
      `echo Origin: ${origin}`,
      "echo ==========================================",
      "",
      'set "OLLAMA_EXE="',
      "for /f \"delims=\" %%I in ('where ollama.exe 2^>nul') do (",
      '  if not defined OLLAMA_EXE set "OLLAMA_EXE=%%~fI"',
      ")",
      'if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe"',
      'if not defined OLLAMA_EXE if exist "%USERPROFILE%\\AppData\\Local\\Programs\\Ollama\\ollama.exe" set "OLLAMA_EXE=%USERPROFILE%\\AppData\\Local\\Programs\\Ollama\\ollama.exe"',
      'if not defined OLLAMA_EXE if exist "%ProgramFiles%\\Ollama\\ollama.exe" set "OLLAMA_EXE=%ProgramFiles%\\Ollama\\ollama.exe"',
      'if not defined OLLAMA_EXE if exist "%ProgramFiles(x86)%\\Ollama\\ollama.exe" set "OLLAMA_EXE=%ProgramFiles(x86)%\\Ollama\\ollama.exe"',
      "",
      "if not defined OLLAMA_EXE (",
      "  echo [ERROR] ollama.exe was not found in PATH or standard folders:",
      "  echo   - %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe",
      "  echo   - %ProgramFiles%\\Ollama\\ollama.exe",
      "  echo Install Ollama from https://ollama.com/download or add its folder to PATH.",
      "  pause",
      "  exit /b 1",
      ")",
      "",
      'echo Found Ollama: "%OLLAMA_EXE%"',
      `set "OLLAMA_ORIGINS=${origin}"`,
      "echo Closing existing Ollama instances...",
      'taskkill /f /im "ollama app.exe" >nul 2>&1',
      "taskkill /f /im ollama.exe >nul 2>&1",
      "timeout /t 1 /nobreak >nul",
      "echo Starting Ollama with CORS enabled for %OLLAMA_ORIGINS%...",
      'start "Ollama Server" "%OLLAMA_EXE%" serve',
      "pause",
    ];
    const batContent = batLines.join("\r\n") + "\r\n";
    const blob = new Blob([batContent], { type: "application/bat" });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = "start-ollama.bat";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  const handleAttachDocs = async (
    e: React.ChangeEvent<HTMLInputElement>,
    onError: (msg: string | null) => void,
  ) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files) as File[];
    const newDocs: AttachedDoc[] = [];
    const oversizedNames: string[] = [];
    const MAX_FILE_SIZE = 5 * 1024 * 1024;

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        oversizedNames.push(file.name);
        continue;
      }
      try {
        const content = await file.text();
        newDocs.push({ name: file.name, content });
      } catch (err) {
        console.error(`Failed to read file ${file.name}`, err);
      }
    }
    if (oversizedNames.length > 0) {
      onError(`Skipped oversized file(s) (>5MB): ${oversizedNames.join(", ")}`);
    } else {
      onError(null);
    }
    setAttachedDocs((prev) => [...prev, ...newDocs]);
    e.target.value = "";
  };

  const removeAttachedDoc = (index: number) => {
    setAttachedDocs((prev) => prev.filter((_, i) => i !== index));
  };

  const getSystemPrompt = (mode: string, customText?: string): string => {
    const template = getTemplate(mode);
    if (!template) {
      return customText || "";
    }
    const promptParts = [template.systemInstruction];
    if (template.deliverables?.length) {
      promptParts.push(
        "",
        "## Required Deliverables",
        ...template.deliverables.map((d) => `- ${d}`),
      );
    }
    if (template.successMetrics?.length) {
      promptParts.push(
        "",
        "## Success Criteria",
        ...template.successMetrics.map((m) => `- ${m}`),
      );
    }
    if (template.evidenceRequirements?.length) {
      promptParts.push(
        "",
        "## Evidence Requirements",
        ...template.evidenceRequirements.map((ev) => `- ${ev}`),
      );
    }
    if (template.tone) {
      promptParts.push("", "## Tone", template.tone);
    }
    if (template.constraints?.length) {
      promptParts.push(
        "",
        "## Constraints",
        ...template.constraints.map((c) => `- ${c}`),
      );
    }
    return promptParts.join("\n");
  };

  return {
    url,
    setUrl,
    githubToken,
    setGithubToken,
    maxFiles,
    setMaxFiles,
    inputMode,
    setInputMode,
    localFiles,
    setLocalFiles,
    nativeLocalPath,
    setNativeLocalPath,
    referenceInputMode,
    setReferenceInputMode,
    referenceUrl,
    setReferenceUrl,
    referenceLocalFiles,
    setReferenceLocalFiles,
    referenceNativeLocalPath,
    setReferenceNativeLocalPath,
    referenceMaxFiles,
    setReferenceMaxFiles,
    useReferenceRepo,
    setUseReferenceRepo,
    templateMode,
    savedTemplates,
    customInstruction,
    setCustomInstruction,
    setTemplateMode,
    additionalContext,
    setAdditionalContext,
    ragQuery,
    setRagQuery,
    attachedDocs,
    analyzeIssues,
    setAnalyzeIssues,
    newTemplateName,
    setNewTemplateName,
    isSavingNew,
    setIsSavingNew,
    confirmDeleteTemplateId,
    setConfirmDeleteTemplateId,
    aiProvider,
    setAiProvider,
    geminiModel,
    setGeminiModel,
    geminiThinkingLevel,
    setGeminiThinkingLevel,
    geminiApiKey,
    setGeminiApiKey,
    proxyAddress,
    setProxyAddress,
    keySourceInfo,
    customBaseUrl,
    setCustomBaseUrl,
    customApiKey,
    setCustomApiKey,
    customModel,
    setCustomModel,
    availableCustomModels,
    testingCustomProvider,
    customProviderConnected,
    setCustomProviderConnected,
    customProviderError,
    useOllama,
    setUseOllama,
    useOllamaForFinal,
    setUseOllamaForFinal,
    localEngine,
    setLocalEngine,
    useRag,
    setUseRag,
    isDeepAnalysis,
    setIsDeepAnalysis,
    ragModel,
    setRagModel,
    ragTopK,
    setRagTopK,
    ragChunkSize,
    setRagChunkSize,
    ragSearchStrategy,
    setRagSearchStrategy,
    ollamaUrl,
    setOllamaUrl,
    ollamaModel,
    setOllamaModel,
    ollamaNumCtx,
    setOllamaNumCtx,
    ollamaNativeRunning,
    ollamaNativeLoading,
    ollamaSummaryPredict,
    setOllamaSummaryPredict,
    ollamaFinalPredict,
    setOllamaFinalPredict,
    fileTruncationLimit,
    setFileTruncationLimit,
    ollamaTemperature,
    setOllamaTemperature,
    useQueryExpansion,
    setUseQueryExpansion,
    useOllamaForQueryExpansion,
    setUseOllamaForQueryExpansion,
    useIntentReranking,
    setUseIntentReranking,
    ollamaConnected,
    setOllamaConnected,
    availableModels,
    testingOllama,
    handleTemplateChange,
    handleSaveTemplate,
    confirmSaveTemplate,
    handleDeleteTemplate,
    handleExportTemplates,
    handleImportTemplates,
    handleTestLocalEngine,
    handleTestCustomProvider,
    handleStartOllama,
    handleStopOllama,
    handleDownloadBat,
    handleAttachDocs,
    removeAttachedDoc,
    getSystemPrompt,
  };
}
