import React, { useState, useEffect, useRef } from "react";
import {
  Github,
  FileText,
  Loader2,
  Copy,
  Check,
  Download,
  Settings2,
  AlertTriangle,
  Save,
  Trash2,
  Folder,
  History,
  Sun,
  Moon,
  Monitor,
  Eye,
  EyeOff,
  ChevronDown,
  Database,
  Paperclip,
  X,
} from "lucide-react";
import {
  fetchRepoData,
  processLocalFolder,
  generateSystemPrompt,
  buildPromptText,
  rewriteQueryWithGemini,
  checkOllamaConnection,
  summarize_with_ollama,
  fetchOllamaModels,
  generate_final_prompt_with_ollama,
  rewriteQueryWithOllama,
  fetchOpenAICompatibleModels,
  generate_final_prompt_with_openai_compatible,
  rewriteQueryWithOpenAICompatible,
  generatePrompt,
  rewriteQuery,
  AIProvider,
  EmbeddingCacheService,
  HistoryCacheService,
  performRAG,
  getTemplate,
  getAllTemplates,
  saveMarkdownFile,
  isTauri,
  tauriInvoke,
  isOllamaRunningNative,
  startOllamaNative,
  stopOllamaNative,
} from "@repo-prompt-generator/core";
import type { HistoryEntryMeta } from "@repo-prompt-generator/core";
import { getVersion } from "@tauri-apps/api/app";

interface SavedTemplate {
  id: string;
  name: string;
  content: string;
}

/**
 * Controlled-from-the-parent, instant-from-the-user textarea. While the
 * field is focused, typing re-renders ONLY this tiny component — the
 * whole-App render (~34ms) must never interleave with keystrokes (it ate
 * the first letters of fast-typed words). The parent state is committed
 * on blur and on unmount; the echo of our own commit is recognized via
 * `committed` and never overwrites newer local text.
 */
function DeferredTextarea({
  id,
  value,
  onCommit,
  rows,
  placeholder,
  className,
  onInput,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  onInput?: (e: React.FormEvent<HTMLTextAreaElement>) => void;
}) {
  const [local, setLocal] = useState(value);
  const latest = useRef(value);
  const committed = useRef(value);

  // External resets (e.g. loading a saved template) win; the parent echoing
  // back what we just committed must NOT clobber newer local keystrokes.
  useEffect(() => {
    if (value !== committed.current) {
      setLocal(value);
      latest.current = value;
    }
    committed.current = value;
  }, [value]);

  // Unmount safety (e.g. the template switcher hides this field).
  useEffect(
    () => () => {
      if (latest.current !== committed.current) onCommit(latest.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const commit = () => {
    if (latest.current !== committed.current) {
      onCommit(latest.current);
    }
    committed.current = latest.current;
  };

  return (
    <textarea
      id={id}
      rows={rows}
      placeholder={placeholder}
      className={className}
      onInput={onInput}
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        latest.current = e.target.value;
      }}
      onBlur={commit}
    />
  );
}

/** Collapsible section of the config sidebar. State persists via App. */
function CollapsibleGroup({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line-soft">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-2 transition-colors"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 text-faint shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="text-xs font-semibold text-body uppercase tracking-wide">
          {title}
        </span>
        {summary && (
          <span className="ml-auto text-[11px] text-faint truncate max-w-[45%]">
            {summary}
          </span>
        )}
      </button>
      {open && <div className="px-3 pb-3 space-y-2.5">{children}</div>}
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState("");

  // Load settings from localStorage
  const initialSettings = (() => {
    try {
      const saved = localStorage.getItem("gemini_app_settings");
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  })();

  const [githubToken, setGithubToken] = useState(
    initialSettings.githubToken || "",
  );
  const [maxFiles, setMaxFiles] = useState(initialSettings.maxFiles || 5);
  const [inputMode, setInputMode] = useState<"github" | "local">(
    initialSettings.inputMode || "github",
  );
  // The picked FileList lives in a ref — NEVER in React state or in the
  // DOM: a 25k-file <input webkitdirectory> left in the tree freezes the
  // desktop WebView2 (UIA/IME walks it on every focus change). The input
  // element is unmounted right after the pick and replaced with a fresh
  // empty one (pickerKey); state carries only count+root for the label.
  const localFilesRef = React.useRef<FileList | null>(null);
  const [localFilesMeta, setLocalFilesMeta] = useState<{
    count: number;
    root: string;
  } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  // Reference Repository State
  const [referenceInputMode, setReferenceInputMode] = useState<
    "github" | "local"
  >("github");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceLocalFiles, setReferenceLocalFiles] =
    useState<FileList | null>(null);
  const [referenceMaxFiles, setReferenceMaxFiles] = useState(
    initialSettings.maxFiles || 5,
  );
  const [cachedReferenceRepoData, setCachedReferenceRepoData] =
    useState<any>(null);
  const [referenceCacheKey, setReferenceCacheKey] = useState<string>("");
  const [useReferenceRepo, setUseReferenceRepo] = useState(false);

  const [templateMode, setTemplateMode] = useState<string>("default");
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    try {
      const saved = localStorage.getItem("gemini_custom_templates");
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [customInstruction, setCustomInstruction] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [ragQuery, setRagQuery] = useState("");
  const [attachedDocs, setAttachedDocs] = useState<
    { name: string; content: string }[]
  >([]);
  const [analyzeIssues, setAnalyzeIssues] = useState(false);
  const [useOllama, setUseOllama] = useState(
    initialSettings.useOllama || false,
  );
  const [useOllamaForFinal, setUseOllamaForFinal] = useState(
    initialSettings.useOllamaForFinal || false,
  );
  const [localEngine, setLocalEngine] = useState<"ollama" | "lmstudio" | "llamacpp">(
    initialSettings.localEngine || "ollama",
  );
  const [aiProvider, setAiProvider] = useState<AIProvider>(
    initialSettings.aiProvider || "gemini",
  );
  const [useRag, setUseRag] = useState(initialSettings.useRag || false);
  const [isDeepAnalysis, setIsDeepAnalysis] = useState(initialSettings.isDeepAnalysis || false);
  const [ragModel, setRagModel] = useState(initialSettings.ragModel || "");
  const [ragTopK, setRagTopK] = useState(initialSettings.ragTopK || 10);
  const [ragChunkSize, setRagChunkSize] = useState(
    initialSettings.ragChunkSize || 30,
  );
  const [ragSearchStrategy, setRagSearchStrategy] = useState(
    initialSettings.ragSearchStrategy !== undefined
      ? initialSettings.ragSearchStrategy
      : 0.5,
  );
  const [ollamaUrl, setOllamaUrl] = useState(
    initialSettings.ollamaUrl || "http://localhost:11434",
  );
  const [ollamaModel, setOllamaModel] = useState(
    initialSettings.ollamaModel || "llama3",
  );
  const [ollamaNumCtx, setOllamaNumCtx] = useState(
    initialSettings.ollamaNumCtx || 8192,
  );
  const [ollamaNativeRunning, setOllamaNativeRunning] = useState(false);
  const [ollamaNativeLoading, setOllamaNativeLoading] = useState(false);
  const [ollamaSummaryPredict, setOllamaSummaryPredict] = useState(
    initialSettings.ollamaSummaryPredict || 500,
  );
  const [ollamaFinalPredict, setOllamaFinalPredict] = useState(
    initialSettings.ollamaFinalPredict || 2000,
  );
  const [fileTruncationLimit, setFileTruncationLimit] = useState(
    initialSettings.fileTruncationLimit !== undefined
      ? initialSettings.fileTruncationLimit
      : 2000,
  );
  const [ollamaTemperature, setOllamaTemperature] = useState(
    initialSettings.ollamaTemperature !== undefined
      ? initialSettings.ollamaTemperature
      : 0.3,
  );
  const [useQueryExpansion, setUseQueryExpansion] = useState(
    initialSettings.useQueryExpansion !== undefined
      ? initialSettings.useQueryExpansion
      : true,
  );
  const [useOllamaForQueryExpansion, setUseOllamaForQueryExpansion] = useState(
    initialSettings.useOllamaForQueryExpansion || false,
  );
  const [useIntentReranking, setUseIntentReranking] = useState(
    initialSettings.useIntentReranking !== undefined
      ? initialSettings.useIntentReranking
      : true,
  );

  // Custom API Provider State
  const [customBaseUrl, setCustomBaseUrl] = useState(
    initialSettings.customBaseUrl || "",
  );
  const [customApiKey, setCustomApiKey] = useState(
    initialSettings.customApiKey || "",
  );
  const [customModel, setCustomModel] = useState(
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

  // Gemini specific settings
  const [geminiApiKey, setGeminiApiKey] = useState(
    initialSettings.geminiApiKey || "",
  );
  const [geminiModel, setGeminiModel] = useState(
    initialSettings.geminiModel || "",
  );
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [proxyAddress, setProxyAddress] = useState(
    initialSettings.proxyAddress || "",
  );

  // Model picker: list generateContent-capable models for the active key
  const fetchGeminiModels = async () => {
    try {
      if (isTauri()) {
        const models = await tauriInvoke<string[]>("gemini_list_models", {});
        setGeminiModels(models);
      } else if (geminiApiKey) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(geminiApiKey)}`,
        );
        const data: any = await res.json();
        const models = (data.models || [])
          .filter((m: any) =>
            (m.supportedGenerationMethods || []).includes("generateContent"),
          )
          .map((m: any) => String(m.name || "").replace("models/", ""))
          .filter(
            (id: string) =>
              ![
                "tts", "image", "live", "transcribe", "embedding",
                "native-audio", "veo", "computer-use", "customtools",
              ].some((k) => id.includes(k)),
          )
          .sort();
        setGeminiModels(models);
      }
    } catch (e) {
      // The list is a convenience; generation falls back to the default model
    }
  };

  useEffect(() => {
    if (aiProvider !== "gemini") return;
    fetchGeminiModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiProvider, geminiApiKey]);

  const [showAdvancedRag, setShowAdvancedRag] = useState(false);

  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testingOllama, setTestingOllama] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  // Generation sequence: bumping it marks every in-flight run stale, so a
  // cancelled run can never write its result to the UI or history.
  const generationRef = React.useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [lastOptimizedQuery, setLastOptimizedQuery] = useState<{
    query: string;
    intent: string;
  } | null>(null);
  const [generatedFileName, setGeneratedFileName] =
    useState<string>("gemini.md");
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [isSavingNew, setIsSavingNew] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // UI shell state
  const [showTemplateContent, setShowTemplateContent] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("gemini_ui_groups");
      return saved
        ? JSON.parse(saved)
        : { source: true, provider: true, engine: true, desktop: false };
    } catch (e) {
      return { source: true, provider: true, engine: true, desktop: false };
    }
  });

  // Generation history (persisted across sessions)
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntryMeta[]>([]);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const restoringRef = React.useRef(false);

  // Elapsed generation time for the status bar
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!loading) return;
    setElapsedSec(0);
    const t0 = Date.now();
    const iv = setInterval(
      () => setElapsedSec(Math.floor((Date.now() - t0) / 1000)),
      1000,
    );
    return () => clearInterval(iv);
  }, [loading]);

  // Build version, shown in Desktop Settings so the running binary is
  // always identifiable (the user launches target/release/app.exe directly)
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    if (!isTauri()) return;
    getVersion().then(setAppVersion).catch(() => setAppVersion("?"));
  }, []);

  // Which Gemini key the desktop actually uses (env var vs UI field)
  const [geminiKeySource, setGeminiKeySource] = useState<string>("");
  useEffect(() => {
    if (!isTauri()) return;
    const t = setTimeout(() => {
      tauriInvoke<string>("get_gemini_key_source", {})
        .then(setGeminiKeySource)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [geminiApiKey]);

  // Theme: "system" follows the OS, light/dark force it. The initial class
  // was already set by the inline bootstrap in index.html.
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    const t = localStorage.getItem("app_theme");
    return t === "light" || t === "dark" ? t : "system";
  });

  const applyThemeClass = (setting: "system" | "light" | "dark") => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
    if (setting === "dark") root.classList.add("theme-dark");
    if (setting === "light") root.classList.add("theme-light");
  };

  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // Re-resolve when the OS theme changes while in "system" mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") applyThemeClass("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setThemeSetting = (value: "system" | "light" | "dark") => {
    setTheme(value);
    localStorage.setItem("app_theme", value);
  };

  // Reveal password-style fields on demand
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);

  const [tokenWarningResolver, setTokenWarningResolver] = useState<
    ((proceed: boolean) => void) | null
  >(null);
  const [tokenWarning, setTokenWarning] = useState<{
    inputTokens: number;
    availableTokens: number;
    requestedTokens: number;
    promptText: string;
  } | null>(null);

  // Cache state
  const [cachedRepoData, setCachedRepoData] = useState<any>(null);
  const [cacheKey, setCacheKey] = useState<string>("");

  useEffect(() => {
    if (isTauri()) {
      isOllamaRunningNative().then((running) => {
        setOllamaNativeRunning(running);
      });
    }
  }, []);

  // Auto-check the local engine on startup and whenever the engine or its
  // URL changes (debounced) — replaces the manual "Test Connection" button.
  useEffect(() => {
    if (!isTauri()) return;
    const t = setTimeout(() => {
      handleTestLocalEngine();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localEngine, ollamaUrl]);

  // Auto-clear RAG query optimization cache when repo or template changes
  // AND Prune unused embedding caches
  useEffect(() => {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("rag_opt_")) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      console.log(
        `[Auto-Clear] Repo/Template changed. Clearing ${keysToRemove.length} stale RAG query optimizations.`,
      );
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    }

    // Prune unused embedding caches (surgical cleanup)
    const activeRepos = [url];
    if (useReferenceRepo && referenceUrl) {
      activeRepos.push(referenceUrl);
    }
    EmbeddingCacheService.pruneUnusedCaches(activeRepos);
  }, [url, templateMode, referenceUrl, useReferenceRepo]);

  useEffect(() => {
    const settings = {
      inputMode,
      githubToken,
      maxFiles,
      useOllama,
      useOllamaForFinal,
      localEngine,
      aiProvider,
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
      geminiModel,
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
    useRag,
    isDeepAnalysis,
    ragModel,
    ragTopK,
    ragChunkSize,
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
    ragSearchStrategy,
    geminiApiKey,
    geminiModel,
    proxyAddress,
  ]);

  useEffect(() => {
    if (isTauri()) {
      tauriInvoke("set_app_config", {
        // null when the UI field is empty — never overwrite the env-provided
        // key with an empty string (Rust keeps the previous value on None).
        gemini_key: geminiApiKey || null,
        proxy: proxyAddress,
        custom_base_url: customBaseUrl,
        ollama_url: ollamaUrl,
      }).catch(console.error);
    }
  }, [geminiApiKey, proxyAddress, customBaseUrl, ollamaUrl]);

  // Restore the last generated prompt on startup so it survives restarts
  useEffect(() => {
    (async () => {
      const entries = await HistoryCacheService.listEntries();
      setHistoryEntries(entries);
      if (entries.length > 0) {
        const content = await HistoryCacheService.getContent(entries[0].id);
        if (content) {
          restoringRef.current = true;
          setGeneratedFileName(entries[0].fileName);
          setUsedModel(entries[0].model || null);
          setRestoredAt(entries[0].createdAt);
          setPrompt(content);
        }
      }
    })();
  }, []);

  // Persist every freshly generated prompt (restored ones are skipped)
  useEffect(() => {
    if (!prompt) return;
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    setRestoredAt(null);
    const sourceLabel =
      inputMode === "github"
        ? url || "GitHub"
        : localFilesMeta
          ? `Local: ${localFilesMeta.root}`
          : "Local Folder";
    const templateName =
      templateMode === "custom"
        ? "Custom"
        : templateMode.startsWith("user_")
          ? savedTemplates.find((t) => t.id === templateMode)?.name ||
            templateMode
          : getTemplate(templateMode)?.metadata.name || templateMode;
    HistoryCacheService.saveEntry({
      content: prompt,
      sourceLabel,
      templateName,
      model: usedModel || "",
      fileName: generatedFileName,
    })
      .then(() => HistoryCacheService.listEntries())
      .then(setHistoryEntries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  // Close the history popover with Escape
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  const handleOpenHistory = async () => {
    setHistoryEntries(await HistoryCacheService.listEntries());
    setHistoryOpen((v) => !v);
  };

  const handleLoadHistoryEntry = async (meta: HistoryEntryMeta) => {
    const content = await HistoryCacheService.getContent(meta.id);
    if (!content) return;
    restoringRef.current = true;
    setGeneratedFileName(meta.fileName);
    setUsedModel(meta.model || null);
    setRestoredAt(meta.createdAt);
    setPrompt(content);
    setCopied(false);
    setHistoryOpen(false);
  };

  const handleDeleteHistoryEntry = async (id: string) => {
    await HistoryCacheService.deleteEntry(id);
    setHistoryEntries(await HistoryCacheService.listEntries());
  };

  const handleClearHistory = async () => {
    await HistoryCacheService.clear();
    setHistoryEntries([]);
  };

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("gemini_ui_groups", JSON.stringify(next));
      return next;
    });
  };

  // High-frequency status updates (per-file summarize, per-chunk RAG) each
  // cost a full-App render; coalescing them keeps UI-responsive typing
  // while a generation runs. Instant statuses (start of a phase) pass through.
  const statusThrottleRef = React.useRef(0);
  const setStatusThrottled = (msg: string) => {
    const now = Date.now();
    if (now - statusThrottleRef.current > 250) {
      statusThrottleRef.current = now;
      setStatus(msg);
    }
  };

  const handleTemplateChange = (mode: string) => {
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

  const confirmSaveTemplate = (e?: React.MouseEvent | React.KeyboardEvent) => {
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
    if (!window.confirm("Are you sure you want to delete this template?"))
      return;
    const updated = savedTemplates.filter((t) => t.id !== templateMode);
    setSavedTemplates(updated);
    localStorage.setItem("gemini_custom_templates", JSON.stringify(updated));
    handleTemplateChange("default");
  };

  const handleExportTemplates = () => {
    if (savedTemplates.length === 0) {
      alert("No custom templates to export.");
      return;
    }
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

  const handleImportTemplates = (e: React.ChangeEvent<HTMLInputElement>) => {
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
          alert(`Successfully imported ${added} templates.`);
        } else {
          alert("Invalid templates file format.");
        }
      } catch (err) {
        alert("Failed to parse templates file.");
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
    } catch (e) {
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
    if (!customBaseUrl || !customApiKey) {
      alert("Please enter both Base URL and API Key.");
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
      // Removed auto-select of models[0] so the input remains empty and the user can see the full unfiltered datalist.
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
      const msg = await startOllamaNative();
      console.log(msg);
      setOllamaNativeRunning(true);
      setTimeout(() => handleTestLocalEngine(), 2000); // Test connection after starting
    } catch (e) {
      console.error("Failed to start Ollama", e);
    } finally {
      setOllamaNativeLoading(false);
    }
  };

  const handleStopOllama = async () => {
    setOllamaNativeLoading(true);
    try {
      const msg = await stopOllamaNative();
      console.log(msg);
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
    const batContent = `@echo off
color 0A
echo ==========================================
echo Starting Ollama with CORS enabled...
echo You can now use Repo Prompt Generator!
echo ==========================================
set OLLAMA_ORIGINS="${origin}"
echo Closing existing Ollama instances...
taskkill /f /im ollama.exe >nul 2>&1
echo Starting Ollama with CORS enabled for ${origin}...
start "" ollama serve
pause`;
    const blob = new Blob([batContent], { type: "application/bat" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "start-ollama.bat";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAttachDocs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files) as File[];
    const newDocs: { name: string; content: string }[] = [];
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        console.warn(`Skipping file ${file.name}: exceeds 5MB limit.`);
        alert(`File ${file.name} is too large (max 5MB).`);
        continue;
      }
      try {
        const content = await file.text();
        newDocs.push({ name: file.name, content });
      } catch (err) {
        console.error(`Failed to read file ${file.name}`, err);
      }
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
      // Fallback to original behavior for custom or saved templates
      return customText || "";
    }

    // Build enhanced prompt with deliverables and metrics
    const promptParts = [template.systemInstruction];

    if (template.deliverables && template.deliverables.length > 0) {
      promptParts.push(
        "",
        "## 📦 Required Deliverables",
        ...template.deliverables.map((d) => `- ${d}`),
      );
    }

    if (template.successMetrics && template.successMetrics.length > 0) {
      promptParts.push(
        "",
        "## ✅ Success Criteria",
        ...template.successMetrics.map((m) => `- ${m}`),
      );
    }

    if (
      template.evidenceRequirements &&
      template.evidenceRequirements.length > 0
    ) {
      promptParts.push(
        "",
        "## 🔍 Evidence Requirements",
        ...template.evidenceRequirements.map((e) => `- ${e}`),
      );
    }

    if (template.tone) {
      promptParts.push("", "## 🎭 Tone", template.tone);
    }

    if (template.constraints && template.constraints.length > 0) {
      promptParts.push(
        "",
        "## ⚠️ Constraints",
        ...template.constraints.map((c) => `- ${c}`),
      );
    }

    return promptParts.join("\n");
  };

  const cancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    generationRef.current++;
    setLoading(false);
    setStatus("Generation cancelled by user.");
  };

  const delay = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Aborted"));
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
      });
    });
  };

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (inputMode === "github" && !url) return;
    if (inputMode === "local" && (!localFilesRef.current || localFilesRef.current.length === 0))
      return;

    if (useRag && !ragModel) {
      setError(
        "Please select an Embedding Model for RAG. It is required to process the repository files.",
      );
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const genId = ++generationRef.current;
    const ensureLive = () => {
      if (
        genId !== generationRef.current ||
        abortControllerRef.current?.signal.aborted
      ) {
        throw new Error("__CANCELLED__");
      }
    };

    let cancelled = false;
    setLoading(true);
    setError(null);
    setPrompt(null);
    setUsedModel(null);
    setLastOptimizedQuery(null);
    setCopied(false);

    // Truncation is a transient notice, not a persistent state (the old
    // persistent warning used to cover the progress in the status bar).
    const warnTruncated = () => {
      setStatus("Large repository: directory tree truncated to 1000 items.");
      setTimeout(() => setStatus((s) =>
        s === "Large repository: directory tree truncated to 1000 items." ? "" : s,
      ), 8000);
    };

    try {
      let repoData;

      if (inputMode === "github") {
        const currentCacheKey = `${url}-${githubToken}-${maxFiles}`;

        if (cachedRepoData && cacheKey === currentCacheKey) {
          setStatus("Using cached repository data...");
          repoData = cachedRepoData;
        } else {
          setStatus("Fetching repository data...");
          repoData = await fetchRepoData(url, githubToken, maxFiles);
          setCachedRepoData(repoData);
          setCacheKey(currentCacheKey);
        }
      } else {
        // Local mode caches processed repo data by folder identity, so
        // re-generating with another template/provider reuses it instead of
        // re-reading the folder. The FileList itself stays in the ref — it is
        // only lightweight File metadata (contents are read lazily), and
        // since F-31 it lives outside the DOM, so holding it is free.
        const currentCacheKey = `local:${localFilesMeta?.root ?? ""}:${localFilesMeta?.count ?? 0}:${maxFiles}`;

        if (cachedRepoData && cacheKey === currentCacheKey) {
          setStatus("Using cached repository data...");
          repoData = cachedRepoData;
        } else {
          setStatus("Processing local files...");
          repoData = await processLocalFolder(localFilesRef.current!, maxFiles);
          setCachedRepoData(repoData);
          setCacheKey(currentCacheKey);
        }
      }

      ensureLive();

      if (repoData.isTruncated) {
        warnTruncated();
      }

      // Generate file name base
      let projectName = "project";
      if (repoData.info && repoData.info.repo) {
        projectName = repoData.info.repo;
      }
      const templateName = templateMode === "default" ? "gemini" : templateMode;
      const date = new Date();
      const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;

      let referenceRepoData;
      const isCustomMode =
        templateMode === "custom" || templateMode.startsWith("user_");
      const shouldFetchReference =
        templateMode === "integration" || (isCustomMode && useReferenceRepo);

      if (shouldFetchReference) {
        if (referenceInputMode === "github" && referenceUrl) {
          const currentRefCacheKey = `${referenceUrl}-${githubToken}-${referenceMaxFiles}`;
          if (
            cachedReferenceRepoData &&
            referenceCacheKey === currentRefCacheKey
          ) {
            setStatus("Using cached reference repository data...");
            referenceRepoData = cachedReferenceRepoData;
          } else {
            setStatus("Fetching reference repository data...");
            referenceRepoData = await fetchRepoData(
              referenceUrl,
              githubToken,
              referenceMaxFiles,
            );
            setCachedReferenceRepoData(referenceRepoData);
            setReferenceCacheKey(currentRefCacheKey);
          }
        } else if (
          referenceInputMode === "local" &&
          referenceLocalFiles &&
          referenceLocalFiles.length > 0
        ) {
          setStatus("Processing local reference files...");
          referenceRepoData = await processLocalFolder(
            referenceLocalFiles,
            referenceMaxFiles,
          );
          setCachedReferenceRepoData(null);
          setReferenceCacheKey("");
        }

        if (referenceRepoData && referenceRepoData.isTruncated) {
          warnTruncated();
        }
      }

      ensureLive();

      let finalUsedRagQuery = "";
      let finalUsedOptimizedQuery = "";

      if (useRag && repoData.sourceFiles && repoData.sourceFiles.length > 0) {
        try {
          const getFallbackQuery = () => {
            const template = getTemplate(templateMode);
            let query = template
              ? template.defaultSearchQuery
              : customInstruction.substring(0, 500);

            // Append user context to specialize the RAG query
            if (additionalContext.trim()) {
              query += `\n\nSpecific Task Context: ${additionalContext.substring(0, 500)}`;
            }
            if (attachedDocs.length > 0) {
              const docNames = attachedDocs.map((d) => d.name).join(", ");
              query += `\n\nAttached Documents: ${docNames}`;
            }
            return query;
          };

          let baseQuery =
            ragQuery.trim() !== "" ? ragQuery : getFallbackQuery();
          let optimizedQuery = baseQuery;
          let queryIntent = "GENERAL";

          // Optimization: Skip LLM call if using a standard template's default query AND no extra context is provided
          const hasExtraContext =
            additionalContext.trim() !== "" || attachedDocs.length > 0;
          const isStandardTemplateDefault =
            ragQuery.trim() === "" &&
            getTemplate(templateMode) !== undefined &&
            !hasExtraContext;

          if (
            (useQueryExpansion || useIntentReranking) &&
            !isStandardTemplateDefault
          ) {
            setStatus("Optimizing RAG query with LLM...");
            try {
              // Simple caching to avoid repeated LLM calls for the same custom template
              // We include more context in the key to prevent stale results when instructions change
              const queryHash =
                baseQuery.length +
                "_" +
                baseQuery.substring(0, 30) +
                "_" +
                baseQuery.substring(baseQuery.length - 30);
              const contextHash =
                additionalContext.length +
                "_" +
                additionalContext.substring(0, 20);
              const cacheKey = `rag_opt_${aiProvider}_${templateMode}_${queryHash}_${contextHash}`;
              const cached = localStorage.getItem(cacheKey);

              if (cached) {
                const parsed = JSON.parse(cached);
                if (useQueryExpansion) {
                  optimizedQuery = parsed.optimizedQuery;
                  setStatus(`RAG query optimized (cached): ${optimizedQuery}`);
                }
                if (useIntentReranking) {
                  queryIntent = parsed.intent;
                }
                setLastOptimizedQuery({
                  query: optimizedQuery,
                  intent: queryIntent,
                });
              } else {
                let result;
                if (useOllamaForQueryExpansion) {
                  if (localEngine === "ollama") {
                    result = await rewriteQueryWithOllama(
                      baseQuery,
                      ollamaUrl,
                      ollamaModel,
                    );
                  } else {
                    result = await rewriteQueryWithOpenAICompatible(
                      baseQuery,
                      ollamaUrl,
                      "sk-dummy-key",
                      ollamaModel,
                    );
                  }
                } else {
                  result = await rewriteQuery(aiProvider, baseQuery, {
                    customBaseUrl,
                    customApiKey,
                    customModel,
                    geminiApiKey,
                    proxyAddress,
                    geminiModel,
                  });
                }

                if (useQueryExpansion) {
                  optimizedQuery = result.optimizedQuery;
                  setStatus(`RAG query optimized: ${optimizedQuery}`);
                }
                if (useIntentReranking) {
                  queryIntent = result.intent;
                }

                // Save to cache
                localStorage.setItem(
                  cacheKey,
                  JSON.stringify({
                    optimizedQuery: result.optimizedQuery,
                    intent: result.intent,
                  }),
                );
                setLastOptimizedQuery({
                  query: optimizedQuery,
                  intent: queryIntent,
                });
              }

              console.log("Original RAG query:", baseQuery);
              console.log("Optimized RAG query:", optimizedQuery);
              console.log("Detected Intent:", queryIntent);
            } catch (e) {
              console.warn(
                "Query optimization failed, using original query",
                e,
              );
              setLastOptimizedQuery(null);
            }
          } else {
            if (isStandardTemplateDefault) {
              console.log(
                "Skipping LLM expansion: using standard template default RAG query.",
              );
              // Map intent based on template if possible
              if (templateMode === "audit" || templateMode === "security")
                queryIntent = "BUGFIX";
              else if (
                templateMode === "architecture" ||
                templateMode === "integration"
              )
                queryIntent = "ARCHITECTURE";
              else if (templateMode === "docs" || templateMode === "eli5")
                queryIntent = "GENERAL";
            }
            setLastOptimizedQuery({
              query: optimizedQuery,
              intent: queryIntent,
            });
          }

          const finalRagQuery = optimizedQuery.substring(0, 1000);
          finalUsedRagQuery = ragQuery;
          finalUsedOptimizedQuery = finalRagQuery;

          // Update the UI state so the user can see what was actually used for the search
          if (!lastOptimizedQuery || lastOptimizedQuery.query.trim() === "") {
            setLastOptimizedQuery({
              query: finalRagQuery,
              intent: queryIntent || "AUTO_FALLBACK",
            });
          }

          setStatus("Running RAG: Filtering codebase...");
          const ragFiles = await performRAG(
            repoData.sourceFiles,
            finalRagQuery,
            queryIntent,
            ollamaUrl,
            ragModel,
            url, // Target repo URL
            ragTopK,
            ragSearchStrategy,
            ragChunkSize,
            (msg) => setStatus(msg),
            localEngine
          );
          repoData = { ...repoData, sourceFiles: ragFiles };

          if (
            referenceRepoData &&
            referenceRepoData.sourceFiles &&
            referenceRepoData.sourceFiles.length > 0
          ) {
            setStatus("Running RAG: Filtering reference codebase...");
            const refRagFiles = await performRAG(
              referenceRepoData.sourceFiles,
              finalRagQuery,
              queryIntent,
              ollamaUrl,
              ragModel,
              referenceUrl, // Reference repo URL
              ragTopK,
              ragSearchStrategy,
              ragChunkSize,
              (msg) => setStatus(msg),
              localEngine
            );
            referenceRepoData = {
              ...referenceRepoData,
              sourceFiles: refRagFiles,
            };
          }
        } catch (e: any) {
          setError(`RAG failed: ${e.message}`);
          setLoading(false);
          return;
        }
      }

      ensureLive();

      let usedOllama = false;
      if (useOllama && ollamaConnected !== false) {
        setStatus(`Summarizing with ${localEngine === "ollama" ? "local Ollama" : localEngine === "lmstudio" ? "LM Studio" : "Llama.cpp"}...`);
        usedOllama = true;

        const summarize = async (text: string) => {
          if (!text) return "";
          if (localEngine === "ollama") {
            return await summarize_with_ollama(
              text,
              ollamaUrl,
              ollamaModel,
              ollamaNumCtx,
              ollamaSummaryPredict,
              ollamaTemperature,
            );
          } else {
             const summaryPrompt = `Please summarize the following file content in a few sentences, extracting only the most important information relevant for understanding the architecture, purpose, and key logic of the code. Ignore boilerplate.\n\nContent:\n${text.substring(0, 8000)}`;
             return await generate_final_prompt_with_openai_compatible(
                summaryPrompt,
                ollamaUrl,
                "sk-dummy-key",
                ollamaModel,
                ollamaTemperature,
             );
          }
        };

        const summarizedSourceFiles = [];
        if (repoData.sourceFiles) {
          const total = repoData.sourceFiles.length;
          for (let i = 0; i < total; i++) {
            const file = repoData.sourceFiles[i];
            setStatusThrottled(`Summarizing ${i + 1}/${total}: ${file.path} (${localEngine === "ollama" ? "Ollama" : "Local Engine"})...`);
            const summary = await summarize(file.content);
            summarizedSourceFiles.push({ path: file.path, content: summary });
          }
        }

        repoData = {
          ...repoData,
          readme: await summarize(repoData.readme),
          dependencies: await summarize(repoData.dependencies),
          sourceFiles: summarizedSourceFiles,
        };

        if (referenceRepoData) {
          const refSummarizedSourceFiles = [];
          if (referenceRepoData.sourceFiles) {
            const refTotal = referenceRepoData.sourceFiles.length;
            for (let i = 0; i < refTotal; i++) {
              const file = referenceRepoData.sourceFiles[i];
              setStatusThrottled(`Summarizing reference ${i + 1}/${refTotal}: ${file.path}...`);
              const summary = await summarize(file.content);
              refSummarizedSourceFiles.push({
                path: file.path,
                content: summary,
              });
            }
          }
          referenceRepoData = {
            ...referenceRepoData,
            readme: await summarize(referenceRepoData.readme),
            dependencies: await summarize(referenceRepoData.dependencies),
            sourceFiles: refSummarizedSourceFiles,
          };
        }
      }

      ensureLive();

      let generatedPrompt = "";
      let finalModel = "";
      let requestedFiles: string[] = [];
      let fetchedFilesCount: number | undefined = undefined;
      let fetchedFilesDetails: any[] | undefined = undefined;
      const taskInstruction = getSystemPrompt(templateMode, customInstruction);
      const engineName = localEngine === "ollama" ? "Ollama" : localEngine === "lmstudio" ? "LM Studio" : "Llama.cpp";

      if (useOllamaForFinal && ollamaConnected !== false) {
        setStatus(`Generating final prompt with local ${engineName}...`);
        const promptText = buildPromptText(
          repoData,
          taskInstruction,
          additionalContext,
          analyzeIssues,
          referenceRepoData,
          attachedDocs,
          fileTruncationLimit,
        );

        const inputTokens = Math.ceil(promptText.length / 4);
        const availableTokens = ollamaNumCtx - inputTokens;

        if (localEngine === "ollama" && availableTokens < ollamaFinalPredict) {
          const proceed = await new Promise<boolean>((resolve) => {
            setTokenWarning({
              inputTokens,
              availableTokens,
              requestedTokens: ollamaFinalPredict,
              promptText,
            });
            setTokenWarningResolver(() => resolve);
          });

          setTokenWarning(null);
          setTokenWarningResolver(null);

          if (!proceed) {
            setLoading(false);
            setStatus("");
            return;
          }
        }

        if (localEngine === "ollama") {
          generatedPrompt = await generate_final_prompt_with_ollama(
            promptText,
            ollamaUrl,
            ollamaModel,
            ollamaNumCtx,
            ollamaFinalPredict,
            ollamaTemperature,
          );
        } else {
          generatedPrompt = await generate_final_prompt_with_openai_compatible(
            promptText,
            ollamaUrl,
            "sk-dummy-key",
            ollamaModel,
            ollamaTemperature,
          );
        }

        finalModel = `${localEngine === "ollama" ? "Ollama" : localEngine === "lmstudio" ? "LM Studio" : "Llama.cpp"} (${ollamaModel})`;
      } else {
        setStatus(`Generating system prompt with ${aiProvider}...`);
        const result = await generatePrompt(
          aiProvider,
          repoData,
          taskInstruction,
          additionalContext,
          analyzeIssues,
          usedOllama,
          referenceRepoData,
          attachedDocs,
          {
            customBaseUrl,
            customApiKey,
            customModel,
            fileTruncationLimit,
            geminiApiKey,
            geminiModel,
            proxyAddress,
            isDeepAnalysis,
            onStatusUpdate: setStatus,
            localFiles: inputMode === "local" ? localFilesRef.current : undefined,
            referenceLocalFiles: referenceInputMode === "local" ? referenceLocalFiles : undefined,
          },
        );
        generatedPrompt = result.text;
        finalModel = result.modelVersion;
        if (result.requestedFiles) {
          requestedFiles = result.requestedFiles;
          fetchedFilesCount = result.fetchedFilesCount;
          fetchedFilesDetails = result.fetchedFilesDetails;
        }
      }

      let metadata = `> **🤖 Prompt Generation Metadata**\n`;
      metadata += `> - **Model:** ${finalModel}\n`;
      metadata += `> - **Target Repository:** ${url || "Local Folder"}\n`;
      if (referenceRepoData) {
        if (referenceInputMode === "local") {
          metadata += `> - **Reference Repository:** Local Folder\n`;
        } else if (referenceUrl) {
          metadata += `> - **Reference Repository:** ${referenceUrl}\n`;
        }
      }

      if (useRag) {
        if (finalUsedRagQuery) {
          metadata += `> - **Original RAG Query:** "${finalUsedRagQuery}"\n`;
          if (
            finalUsedOptimizedQuery &&
            finalUsedOptimizedQuery !== finalUsedRagQuery
          ) {
            metadata += `> - **Optimized RAG Query:** "${finalUsedOptimizedQuery}"\n`;
          }
        } else {
          metadata += `> - **Auto-generated RAG Query:** "${finalUsedOptimizedQuery || "Unknown"}"\n`;
        }
      }
      if (usedOllama)
        metadata += `> - **Pre-processing:** Local LLM (Ollama)\n`;

      if (requestedFiles && requestedFiles.length > 0) {
        if (fetchedFilesCount !== undefined) {
          metadata += `> - **Agentic RAG Requested Files:** (${fetchedFilesCount}/${requestedFiles.length} fetched)\n`;
        } else {
          metadata += `> - **Agentic RAG Requested Files:**\n`;
        }
        
        // Add detailed file status if available
        if (fetchedFilesDetails) {
          requestedFiles.forEach(file => {
            const detail = fetchedFilesDetails?.find((f: any) => f.path === file);
            if (detail) {
              if (detail.truncated) {
                metadata += `>   - \`${file}\` (⚠️ Truncated: >50KB)\n`;
              } else {
                metadata += `>   - \`${file}\` (✅ Fetched)\n`;
              }
            } else {
              metadata += `>   - \`${file}\` (❌ Not found)\n`;
            }
          });
        } else {
          requestedFiles.forEach(file => {
            metadata += `>   - \`${file}\`\n`;
          });
        }
      }

      metadata += `> \n`;
      metadata += `> <details><summary><b>Task Instructions</b></summary>\n> \n`;
      metadata += `> \`\`\`text\n`;
      metadata +=
        taskInstruction
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n";
      metadata += `> \`\`\`\n`;
      metadata += `> </details>\n`;

      if (additionalContext) {
        metadata += `>\n> <details><summary><b>Additional Context</b></summary>\n> \n`;
        metadata += `> \`\`\`text\n`;
        metadata +=
          additionalContext
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n") + "\n";
        metadata += `> \`\`\`\n`;
        metadata += `> </details>\n`;
      }

      metadata += `\n---\n\n`;

      generatedPrompt = metadata + generatedPrompt;

      ensureLive();

      const safeModelName = finalModel
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase();
      setGeneratedFileName(
        `${projectName}_${templateName}_${safeModelName}_${timestamp}.md`,
      );

      setPrompt(generatedPrompt);
      setUsedModel(finalModel);
    } catch (err: any) {
      if (err?.message === "__CANCELLED__") {
        cancelled = true;
        setStatus("Generation cancelled.");
      } else {
        setError(err.message || "An unexpected error occurred.");
      }
    } finally {
      setLoading(false);
      if (!cancelled) setStatus("");
    }
  };

  const handleCopy = () => {
    if (prompt) {
      navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async () => {
    if (prompt) {
      await saveMarkdownFile(prompt, generatedFileName);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-app text-ink font-sans selection:bg-brand-soft-2 selection:text-brand-ink overflow-hidden">
      <h1 className="sr-only">Repo Prompt Generator</h1>

      {/* ===== Top: task panel (source, template, instructions, status) ===== */}
      <header className="relative shrink-0 bg-surface border-b border-line shadow-sm z-30">
        {/* Row 1: source + generate */}
        <form
          onSubmit={handleGenerate}
          className="flex items-center gap-2 px-3 pt-2 pb-2"
        >
          <div
            className="flex rounded-lg border border-line p-0.5 shrink-0"
            aria-label="Source type"
          >
            <button
              type="button"
              aria-pressed={inputMode === "github"}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${inputMode === "github" ? "bg-brand-fog text-brand-ink" : "text-soft hover:text-body"}`}
              onClick={() => setInputMode("github")}
            >
              <Github className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
              GitHub
            </button>
            <button
              type="button"
              aria-pressed={inputMode === "local"}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${inputMode === "local" ? "bg-brand-fog text-brand-ink" : "text-soft hover:text-body"}`}
              onClick={() => setInputMode("local")}
            >
              <Folder className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
              Local
            </button>
          </div>

          {inputMode === "github" ? (
            <div className="relative flex-1 min-w-0">
              <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
                <Github className="h-4 w-4 text-faint" />
              </div>
              <input
                type="url"
                required
                placeholder="https://github.com/owner/repo"
                className="block w-full pl-8 pr-2.5 py-1.5 border border-input-line rounded-lg leading-5 bg-raised placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand-mid focus:border-brand-mid text-sm transition-shadow"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
              />
            </div>
          ) : (
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-brand-ink bg-brand-fog border border-brand-line hover:bg-brand-soft-2 rounded-lg transition-colors shrink-0">
                <Folder className="w-3.5 h-3.5" />
                {localFilesMeta ? "Choose another" : "Choose folder"}
                <input
                  key={pickerKey}
                  type="file"
                  ref={fileInputRef}
                  // @ts-ignore - webkitdirectory is non-standard but widely supported
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    e.preventDefault();
                    const files = e.target.files;
                    localFilesRef.current = files;
                    const first = files && files.length > 0 ? files[0] : null;
                    setLocalFilesMeta({
                      count: files ? files.length : 0,
                      root: first
                        ? first.webkitRelativePath.split("/")[0]
                        : "",
                    });
                    // Unmount the input that carries the picked files: a
                    // 25k-file directory input left in the DOM freezes the
                    // desktop WebView2. A fresh empty picker takes its place.
                    setPickerKey((k) => k + 1);
                  }}
                  disabled={loading}
                />
              </label>
              {localFilesMeta && localFilesMeta.count > 0 ? (
                <p
                  className="text-xs text-body truncate min-w-0"
                  title={`${localFilesMeta.count} files from ${localFilesMeta.root}`}
                >
                  <span className="font-semibold">{localFilesMeta.count}</span>{" "}
                  files · {localFilesMeta.root}
                </p>
              ) : (
                <p className="text-xs text-faint truncate">
                  no folder selected
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={
              loading ||
              (inputMode === "github"
                ? !url
                : !localFilesRef.current || localFilesRef.current.length === 0)
            }
            title={
              inputMode === "github"
                ? !url
                  ? "Enter a repository URL first"
                  : "Generate the prompt"
                : !localFilesRef.current || localFilesRef.current.length === 0
                  ? "Select a local folder first"
                  : "Generate the prompt"
            }
            className="shrink-0 inline-flex items-center justify-center px-4 py-1.5 border border-transparent text-sm font-medium rounded-lg text-brand-fg bg-brand hover:bg-brand-strong focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-app focus:ring-brand-mid disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin -ml-1 mr-1.5 h-4 w-4" />
                Generating…
              </>
            ) : inputMode === "github" &&
              cachedRepoData &&
              cacheKey === `${url}-${githubToken}-${maxFiles}` ? (
              "Regenerate (Cached)"
            ) : (
              "Generate Prompt"
            )}
          </button>
        </form>

        {/* Row 2: template */}
        <div className="px-3 pb-2 flex items-center gap-2">
          <label
            htmlFor="templateMode"
            className="text-xs font-medium text-soft shrink-0"
          >
            Template
          </label>
          <select
            id="templateMode"
            value={templateMode}
            onChange={(e) => handleTemplateChange(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1.5 border border-input-line rounded-lg leading-5 bg-raised focus:outline-none focus:ring-2 focus:ring-brand-mid focus:border-brand-mid text-sm transition-shadow"
          >
            <optgroup label="Built-in Templates">
              {getAllTemplates().map((template) => (
                <option key={template.metadata.id} value={template.metadata.id}>
                  {template.metadata.name}
                </option>
              ))}
            </optgroup>
            {savedTemplates.length > 0 && (
              <optgroup label="Saved Templates">
                {savedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Custom">
              <option value="custom">Custom Prompt</option>
            </optgroup>
          </select>
          <div className="flex gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleExportTemplates}
              className="text-xs text-brand hover:text-brand-strong font-medium"
            >
              Export
            </button>
            <label className="text-xs text-brand hover:text-brand-strong font-medium cursor-pointer">
              Import
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImportTemplates}
              />
            </label>
          </div>
        </div>

        {getTemplate(templateMode) ? (
          /* Built-in template: read-only, collapsed by default */
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => setShowTemplateContent(!showTemplateContent)}
              aria-expanded={showTemplateContent}
              className="flex items-center text-xs text-soft hover:text-body transition-colors"
            >
              <ChevronDown
                className={`w-3 h-3 mr-1 transition-transform ${showTemplateContent ? "rotate-180" : ""}`}
              />
              Template content ·{" "}
              {getSystemPrompt(templateMode, customInstruction).length.toLocaleString()}{" "}
              chars
            </button>
            {showTemplateContent && (
              <pre className="mt-1.5 block w-full px-2.5 py-2 border border-line rounded-lg bg-app text-mid whitespace-pre-wrap max-h-32 overflow-y-auto font-mono text-[11px] leading-4">
                {getSystemPrompt(templateMode, customInstruction)}
              </pre>
            )}
          </div>
        ) : (
          /* Custom / saved template: editable */
          <div className="px-3 pb-2">
            <DeferredTextarea
              rows={2}
              placeholder="Enter your custom system instruction here. The repository context (Tree, README, Dependencies) will be automatically appended to your prompt."
              className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg leading-5 bg-raised placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand-mid focus:border-brand-mid text-sm resize-none overflow-y-auto [field-sizing:content] max-h-40"
              value={customInstruction}
              onCommit={setCustomInstruction}
            />
            <div className="flex items-center justify-between mt-1.5 gap-2">
              <label className="flex items-center gap-1.5 text-xs text-body cursor-pointer hover:text-brand transition-colors min-w-0">
                <input
                  type="checkbox"
                  className="rounded border-input-line text-brand focus:ring-brand-mid w-3.5 h-3.5 cursor-pointer"
                  checked={useReferenceRepo}
                  onChange={(e) => setUseReferenceRepo(e.target.checked)}
                />
                <Database className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">
                  Add Reference Repository (for comparison, porting, etc.)
                </span>
              </label>
              <div className="flex justify-end gap-2 shrink-0">
                {templateMode.startsWith("user_") && (
                  <button
                    type="button"
                    onClick={handleDeleteTemplate}
                    className="inline-flex items-center px-2 py-1 text-xs font-medium text-danger-strong bg-danger-soft hover:bg-danger-soft rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3 h-3 mr-1" />
                    Delete
                  </button>
                )}
                {templateMode.startsWith("user_") &&
                  customInstruction.trim() !== "" && (
                    <button
                      type="button"
                      onClick={handleSaveTemplate}
                      className="inline-flex items-center px-2 py-1 text-xs font-medium text-brand-ink bg-brand-fog hover:bg-brand-soft-2 border border-brand-line rounded-lg transition-colors"
                    >
                      <Save className="w-3 h-3 mr-1" />
                      Save Changes
                    </button>
                  )}
                {!templateMode.startsWith("user_") &&
                  customInstruction.trim() !== "" &&
                  (isSavingNew ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        placeholder="Template name…"
                        className="px-2 py-1 text-xs border border-input-line rounded-lg focus:ring-brand-mid focus:border-brand-mid w-32"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            confirmSaveTemplate(e);
                          } else if (e.key === "Escape") {
                            setIsSavingNew(false);
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={confirmSaveTemplate}
                        disabled={!newTemplateName.trim()}
                        className="inline-flex items-center px-2 py-1 text-xs font-medium text-brand-fg bg-brand hover:bg-brand-strong rounded-lg transition-colors disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsSavingNew(false)}
                        className="inline-flex items-center px-2 py-1 text-xs font-medium text-body bg-surface-2 hover:bg-surface-3 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsSavingNew(true)}
                      className="inline-flex items-center px-2 py-1 text-xs font-medium text-brand-ink bg-brand-fog hover:bg-brand-soft-2 border border-brand-line rounded-lg transition-colors"
                    >
                      <Save className="w-3 h-3 mr-1" />
                      Save as Template
                    </button>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Row 3: task instructions & context */}
        <div className="px-3 pb-2 flex items-start gap-2">
          <label
            htmlFor="additionalContext"
            className="text-xs font-medium text-soft shrink-0 pt-1.5"
          >
            Instructions
          </label>
          <div className="flex-1 min-w-0">
            <DeferredTextarea
              id="additionalContext"
              rows={1}
              placeholder={
                templateMode === "integration"
                  ? "What do you want to integrate? (Leave empty to let AI discover the best architectural patterns to borrow from the Reference Repo)"
                  : "e.g., I'm planning to add GPU acceleration support for Nvidia RTX 4xxx series…"
              }
              className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg leading-5 bg-raised placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand-mid focus:border-brand-mid text-sm resize-none overflow-y-auto [field-sizing:content] max-h-40"
              value={additionalContext}
              onCommit={setAdditionalContext}
            />
            {attachedDocs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {attachedDocs.map((doc, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 bg-brand-fog text-brand-ink px-2 py-0.5 rounded-md text-xs border border-brand-line"
                  >
                    <Paperclip className="w-3 h-3" />
                    <span className="truncate max-w-[150px]">{doc.name}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachedDoc(i)}
                      aria-label={`Remove ${doc.name}`}
                      className="hover:text-brand-ink ml-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between mt-1.5 gap-2">
              <label
                htmlFor="analyzeIssues"
                className="flex items-center gap-1.5 text-xs text-body cursor-pointer min-w-0"
              >
                <input
                  id="analyzeIssues"
                  type="checkbox"
                  className="h-3.5 w-3.5 text-brand focus:ring-brand-mid border-input-line rounded cursor-pointer"
                  checked={analyzeIssues}
                  onChange={(e) => setAnalyzeIssues(e.target.checked)}
                />
                <span className="truncate">
                  Analyze repository for obvious errors, bugs, and outdated
                  dependencies
                </span>
              </label>
              <div className="flex items-center gap-2 shrink-0">
                {isTauri() && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleTestLocalEngine}
                      disabled={testingOllama}
                      title={`Local engine status — click to re-check. ${ollamaConnected === true ? "Connected" : ollamaConnected === false ? "Not reachable" : "Unknown"}`}
                      className={`flex items-center gap-1.5 text-xs font-medium px-1.5 py-1 rounded-md hover:bg-surface-2 transition-colors disabled:opacity-50 ${
                        ollamaConnected === true
                          ? "text-ok"
                          : ollamaConnected === false
                            ? "text-danger"
                            : "text-soft"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          testingOllama
                            ? "bg-brand-mid animate-pulse"
                            : ollamaConnected === true
                              ? "bg-ok"
                              : ollamaConnected === false
                                ? "bg-danger"
                                : "bg-faint"
                        }`}
                      />
                      {testingOllama ? "Checking…" : "Ollama"}
                    </button>
                    {!ollamaNativeRunning ? (
                      <button
                        type="button"
                        onClick={handleStartOllama}
                        disabled={ollamaNativeLoading}
                        className="text-xs px-2 py-1 bg-ok-soft text-ok border border-ok-line rounded-md hover:bg-ok-soft-2 transition-colors disabled:opacity-50"
                      >
                        {ollamaNativeLoading ? "Starting…" : "Start"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleStopOllama}
                        disabled={ollamaNativeLoading}
                        className="text-xs px-2 py-1 bg-danger-soft text-danger border border-danger-line rounded-md hover:bg-danger-soft transition-colors disabled:opacity-50"
                      >
                        {ollamaNativeLoading ? "Stopping…" : "Stop"}
                      </button>
                    )}
                  </div>
                )}
                <label className="cursor-pointer inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-mid bg-surface-2 hover:bg-surface-3 rounded-lg transition-colors border border-line shrink-0">
                  <Paperclip className="w-3 h-3" />
                  Attach (.md, .txt)
                  <input
                    type="file"
                    multiple
                    accept=".md,.txt,.json,.csv,.log"
                    className="hidden"
                    onChange={handleAttachDocs}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Conditional: reference repository input */}
        {(templateMode === "integration" ||
          ((templateMode === "custom" ||
            templateMode.startsWith("user_")) &&
            useReferenceRepo)) && (
          <div className="px-3 pb-2">
            <div className="rounded-lg border border-line bg-app p-2">
              <div className="flex items-center gap-2 mb-1.5">
                <Database className="w-3.5 h-3.5 text-brand-faint shrink-0" />
                <span className="text-xs font-semibold text-body">
                  Reference Repository (Source of Truth)
                </span>
                <div className="ml-auto flex rounded-md border border-line bg-raised p-0.5">
                  <button
                    type="button"
                    aria-pressed={referenceInputMode === "github"}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${referenceInputMode === "github" ? "bg-brand-fog text-brand-ink" : "text-soft hover:text-body"}`}
                    onClick={() => setReferenceInputMode("github")}
                  >
                    <Github className="w-3 h-3 inline-block mr-0.5 -mt-0.5" />
                    GitHub
                  </button>
                  <button
                    type="button"
                    aria-pressed={referenceInputMode === "local"}
                    className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${referenceInputMode === "local" ? "bg-brand-fog text-brand-ink" : "text-soft hover:text-body"}`}
                    onClick={() => setReferenceInputMode("local")}
                  >
                    <Folder className="w-3 h-3 inline-block mr-0.5 -mt-0.5" />
                    Local
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                {referenceInputMode === "github" ? (
                  <div className="relative flex-1 min-w-0">
                    <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
                      <Github className="h-3.5 w-3.5 text-faint" />
                    </div>
                    <input
                      type="url"
                      placeholder="https://github.com/owner/reference-repo"
                      className="block w-full pl-7 pr-2 py-1 border border-input-line rounded-lg leading-5 bg-raised placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand-mid focus:border-brand-mid text-xs transition-shadow"
                      value={referenceUrl}
                      onChange={(e) => setReferenceUrl(e.target.value)}
                      disabled={loading}
                    />
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">
                    <input
                      type="file"
                      // @ts-ignore
                      webkitdirectory=""
                      directory=""
                      multiple
                      onChange={(e) => {
                        e.preventDefault();
                        setReferenceLocalFiles(e.target.files);
                      }}
                      className="block w-full text-xs text-brand-ink file:mr-2 file:py-1 file:px-2 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-brand-fog file:text-brand-ink hover:file:bg-brand-soft-2 cursor-pointer truncate"
                      disabled={loading}
                    />
                    {referenceLocalFiles &&
                      referenceLocalFiles.length > 0 && (
                        <p className="text-[11px] text-soft mt-0.5">
                          {referenceLocalFiles.length} files selected
                        </p>
                      )}
                  </div>
                )}
                <input
                  type="number"
                  placeholder="Max"
                  aria-label="Reference max files"
                  className="block w-16 shrink-0 px-2 py-1 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                  value={referenceMaxFiles}
                  onChange={(e) =>
                    setReferenceMaxFiles(Number(e.target.value))
                  }
                  min={1}
                  max={
                    referenceInputMode === "local"
                      ? 200
                      : githubToken
                        ? 200
                        : 10
                  }
                  disabled={loading}
                  title={
                    referenceInputMode === "local"
                      ? "Limit: 200 files"
                      : githubToken
                        ? "Limit: 200 files"
                        : "Limit: 10 files (add a token to increase)"
                  }
                />
              </div>
            </div>
          </div>
        )}

        {/* Reserved status bar: progress with elapsed timer, transient
            notices, errors — fixed height, never overlaps content below */}
        <div
          className="shrink-0 h-7 px-3 flex items-center gap-2 border-t border-line-soft text-xs overflow-hidden"
          role="status"
          aria-live="polite"
        >
          {error ? (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
              <span className="text-danger truncate" title={error}>
                {error}
              </span>
            </>
          ) : loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-faint shrink-0" />
              <span className="text-body truncate flex-1">
                {status || "Working…"}
              </span>
              <span className="text-soft tabular-nums shrink-0" title="Elapsed">
                {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, "0")}
              </span>
              <button
                type="button"
                onClick={cancelGeneration}
                className="shrink-0 inline-flex items-center px-2 py-0.5 border border-input-line text-xs font-medium rounded-md text-body bg-raised hover:bg-surface-2 transition-colors"
              >
                <X className="w-3 h-3 mr-1" />
                Cancel
              </button>
            </>
          ) : status ? (
            <span className="text-soft truncate" title={status}>
              {status}
            </span>
          ) : null}
        </div>
      </header>

      {/* ===== Body: config sidebar | result pane ===== */}
      <div className="flex-1 min-h-0 flex">
        {/* Left: configuration */}
        <aside
          aria-label="Configuration"
          className="w-72 shrink-0 border-r border-line bg-surface overflow-y-auto"
        >
          <CollapsibleGroup
            title="Source"
            summary={
              inputMode === "github"
                ? url
                  ? url.replace(/^https?:\/\//, "")
                  : "GitHub"
                : "Local folder"
            }
            open={!!openGroups.source}
            onToggle={() => toggleGroup("source")}
          >
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="githubToken"
                  className="text-[11px] font-medium text-soft"
                >
                  GitHub Token (Optional)
                </label>
                <span
                  className={`text-[11px] font-medium ${githubToken ? "text-ok" : "text-faint"}`}
                >
                  {githubToken ? "✓ set" : "not set"}
                </span>
              </div>
              <div className="relative">
                <input
                  type={showGithubToken ? "text" : "password"}
                  id="githubToken"
                  className="block w-full pr-8 px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                  placeholder="ghp_..."
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowGithubToken((v) => !v)}
                  aria-label={showGithubToken ? "Hide token" : "Show token"}
                  title={showGithubToken ? "Hide token" : "Show token"}
                  className="absolute inset-y-0 right-0 flex items-center px-2 text-faint hover:text-body transition-colors"
                >
                  {showGithubToken ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
            <div>
              <label
                htmlFor="maxFiles"
                className="block text-[11px] font-medium text-soft mb-1"
              >
                Max Source Files to Fetch
              </label>
              <input
                type="number"
                id="maxFiles"
                className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                value={maxFiles}
                onChange={(e) => setMaxFiles(Number(e.target.value))}
                min={1}
                max={inputMode === "local" ? 200 : githubToken ? 200 : 10}
              />
              <p className="mt-1 text-[11px] text-soft leading-tight">
                {inputMode === "local"
                  ? "Limit: 200 files (local processing is fast)."
                  : githubToken
                    ? "Limit: 200 files (token provided)."
                    : "Limit: 10 files (add a token to increase up to 200)."}
              </p>
            </div>
          </CollapsibleGroup>

          <CollapsibleGroup
            title="AI Provider"
            summary={
              aiProvider === "gemini"
                ? "Gemini"
                : customModel || customBaseUrl || "Custom"
            }
            open={!!openGroups.provider}
            onToggle={() => toggleGroup("provider")}
          >
            <select
              value={aiProvider}
              onChange={(e) => setAiProvider(e.target.value as AIProvider)}
              aria-label="AI provider"
              className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs bg-raised focus:ring-brand-mid focus:border-brand-mid"
            >
              <option value="gemini">✨ Gemini (default)</option>
              <option value="custom">🌐 Custom (OpenAI Compatible)</option>
            </select>

            {aiProvider === "gemini" && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="geminiApiKey"
                    className="text-[11px] font-medium text-soft"
                  >
                    Gemini API Key
                  </label>
                  <span
                    className={`text-[11px] font-medium ${
                      geminiApiKey
                        ? "text-ok"
                        : isTauri() && geminiKeySource && geminiKeySource !== "none"
                          ? "text-ok"
                          : "text-faint"
                    }`}
                  >
                    {geminiApiKey
                      ? "✓ set"
                      : isTauri() && geminiKeySource && geminiKeySource !== "none"
                        ? "from env"
                        : "not set"}
                  </span>
                </div>
                <div className="relative">
                  <input
                    type={showGeminiKey ? "text" : "password"}
                    id="geminiApiKey"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="AIzaSy… (or set GEMINI_API_KEY env var)"
                    className="block w-full pr-8 px-2.5 py-1.5 border border-input-line rounded-lg text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGeminiKey((v) => !v)}
                    aria-label={showGeminiKey ? "Hide API key" : "Show API key"}
                    title={showGeminiKey ? "Hide API key" : "Show API key"}
                    className="absolute inset-y-0 right-0 flex items-center px-2 text-faint hover:text-body transition-colors"
                  >
                    {showGeminiKey ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
                {isTauri() && geminiKeySource && (
                  <p className="mt-1 text-[10px] text-faint leading-tight truncate">
                    Active key: {geminiKeySource}
                  </p>
                )}
              </div>
            )}

            {aiProvider === "gemini" && (
              <div>
                <label
                  htmlFor="geminiModel"
                  className="block text-[11px] font-medium text-soft mb-1"
                >
                  Model
                </label>
                {geminiModels.length > 0 ? (
                  <select
                    id="geminiModel"
                    value={geminiModel || "gemini-3.8-flash"}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs bg-raised focus:ring-brand-mid focus:border-brand-mid"
                  >
                    {geminiModel && !geminiModels.includes(geminiModel) && (
                      <option value={geminiModel}>{geminiModel}</option>
                    )}
                    {geminiModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    id="geminiModel"
                    value={geminiModel}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    placeholder="gemini-3.8-flash (default)"
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs"
                  />
                )}
                <p className="mt-1 text-[10px] text-faint leading-tight">
                  The list loads from your API key. Transient server errors
                  (5xx) are retried automatically; quota errors (429) are not.
                </p>
              </div>
            )}

            {aiProvider === "custom" && (
              <div className="rounded-lg border border-line p-2.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-body">
                    Custom Provider
                  </span>
                  <select
                    className="text-[11px] border border-input-line rounded px-1.5 py-1 bg-app max-w-[55%]"
                    onChange={(e) => {
                      if (e.target.value) {
                        setCustomBaseUrl(e.target.value);
                        setCustomProviderConnected(null);
                      }
                    }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Load Preset…
                    </option>
                    <option value="https://openrouter.ai/api/v1">
                      OpenRouter
                    </option>
                    <option value="https://integrate.api.nvidia.com/v1">
                      NVIDIA NIM
                    </option>
                    <option value="https://api.groq.com/openai/v1">Groq</option>
                    <option value="https://api.x.ai/v1">xAI (Grok)</option>
                    <option value="https://models.inference.ai.azure.com">
                      GitHub Models
                    </option>
                    <option value="https://api.mistral.ai/v1">Mistral</option>
                    <option value="https://api.cerebras.ai/v1">
                      Cerebras
                    </option>
                    <option value="https://api.moonshot.cn/v1">
                      Kimi (Moonshot)
                    </option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="customBaseUrl"
                    className="block text-[11px] font-medium text-soft mb-1"
                  >
                    Base URL (OpenAI Compatible)
                  </label>
                  <input
                    type="text"
                    id="customBaseUrl"
                    value={customBaseUrl}
                    onChange={(e) => {
                      setCustomBaseUrl(e.target.value);
                      setCustomProviderConnected(null);
                    }}
                    placeholder="https://api.groq.com/openai/v1"
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="customApiKey"
                      className="text-[11px] font-medium text-soft"
                    >
                      API Key
                    </label>
                    <span
                      className={`text-[11px] font-medium ${customApiKey ? "text-ok" : "text-faint"}`}
                    >
                      {customApiKey ? "✓ set" : "not set"}
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type={showCustomKey ? "text" : "password"}
                      id="customApiKey"
                      value={customApiKey}
                      onChange={(e) => {
                        setCustomApiKey(e.target.value);
                        setCustomProviderConnected(null);
                      }}
                      placeholder="sk-..."
                      className="block w-full pr-8 px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCustomKey((v) => !v)}
                      aria-label={showCustomKey ? "Hide API key" : "Show API key"}
                      title={showCustomKey ? "Hide API key" : "Show API key"}
                      className="absolute inset-y-0 right-0 flex items-center px-2 text-faint hover:text-body transition-colors"
                    >
                      {showCustomKey ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="customModel"
                    className="block text-[11px] font-medium text-soft mb-1"
                  >
                    Model Name
                  </label>
                  <input
                    type="text"
                    id="customModel"
                    list="custom-models-list"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="e.g., llama3-8b-8192"
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid bg-raised"
                  />
                  {availableCustomModels.length > 0 && (
                    <datalist id="custom-models-list">
                      {availableCustomModels
                        .filter((m) =>
                          m.toLowerCase().includes(customModel.toLowerCase()),
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
                  onClick={handleTestCustomProvider}
                  disabled={testingCustomProvider}
                  className="w-full text-xs px-2.5 py-1.5 bg-raised border border-input-line rounded-lg hover:bg-surface-2 transition-colors disabled:opacity-50"
                >
                  {testingCustomProvider ? "Fetching…" : "Fetch Models"}
                </button>

                {customProviderConnected === true && (
                  <p className="text-[11px] text-ok flex items-center">
                    <Check className="w-3 h-3 mr-1" /> Successfully connected to
                    provider
                  </p>
                )}
                {customProviderConnected === false && (
                  <div className="p-2 bg-danger-soft border border-danger-line rounded-lg text-[11px] text-danger flex items-start">
                    <AlertTriangle className="w-3.5 h-3.5 mr-1.5 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <strong>Connection failed:</strong>{" "}
                      {customProviderError || "Check URL and API Key."}
                    </div>
                  </div>
                )}

                <div className="p-2 bg-warn-soft border border-warn-line rounded-lg text-[11px] text-warn-strong flex items-start">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1.5 mt-0.5 shrink-0" />
                  <p>
                    Free API providers often have strict context limits (8k–32k
                    tokens). Keep <strong>RAG enabled</strong> with a small
                    Top-K to avoid "Context length exceeded" errors.
                  </p>
                </div>
              </div>
            )}
          </CollapsibleGroup>

          <CollapsibleGroup
            title="Engine & RAG"
            summary={
              [
                useOllama && "Summary",
                useOllamaForFinal && "Final",
                useRag && "RAG",
                isDeepAnalysis && "Deep",
              ]
                .filter(Boolean)
                .join(" + ") || "Off"
            }
            open={!!openGroups.engine}
            onToggle={() => toggleGroup("engine")}
          >
            <div className="space-y-2">
              <label
                htmlFor="useOllama"
                className="flex items-center gap-2 text-xs text-body cursor-pointer"
              >
                <input
                  id="useOllama"
                  type="checkbox"
                  className="h-3.5 w-3.5 text-brand focus:ring-brand-mid border-input-line rounded cursor-pointer"
                  checked={useOllama}
                  onChange={(e) => setUseOllama(e.target.checked)}
                />
                Local Pre-summarization
              </label>
              <label
                htmlFor="useOllamaForFinal"
                className="flex items-center gap-2 text-xs text-body cursor-pointer"
              >
                <input
                  id="useOllamaForFinal"
                  type="checkbox"
                  className="h-3.5 w-3.5 text-brand focus:ring-brand-mid border-input-line rounded cursor-pointer"
                  checked={useOllamaForFinal}
                  onChange={(e) => setUseOllamaForFinal(e.target.checked)}
                />
                Local Model for Final Generation
              </label>
              <label
                htmlFor="useRag"
                className="flex items-center gap-2 text-xs text-body cursor-pointer"
              >
                <input
                  id="useRag"
                  type="checkbox"
                  className="h-3.5 w-3.5 text-brand focus:ring-brand-mid border-input-line rounded cursor-pointer"
                  checked={useRag}
                  onChange={(e) => setUseRag(e.target.checked)}
                />
                RAG (Smart Context Filter)
              </label>
              {aiProvider === "gemini" && (
                <label
                  htmlFor="isDeepAnalysis"
                  className="flex items-center gap-2 text-xs text-body cursor-pointer"
                >
                  <input
                    id="isDeepAnalysis"
                    type="checkbox"
                    className="h-3.5 w-3.5 text-brand focus:ring-brand-mid border-input-line rounded cursor-pointer"
                    checked={isDeepAnalysis}
                    onChange={(e) => setIsDeepAnalysis(e.target.checked)}
                  />
                  <span className="min-w-0">
                    Agentic RAG (Deep Analysis)
                    <span
                      className="ml-1.5 inline-flex items-center px-1 py-0 rounded text-[10px] font-bold bg-warn-soft-2 text-warn-strong border border-warn-line"
                      title="Warning: This mode sends the full context multiple times, which can triple token usage."
                    >
                      ⚠️ Tokens x3
                    </span>
                  </span>
                </label>
              )}
            </div>

            {(useOllama ||
              useOllamaForFinal ||
              useOllamaForQueryExpansion ||
              useRag) && (
              <div className="space-y-2.5 pt-1 border-t border-line-soft">
                <div>
                  <label
                    htmlFor="localEngine"
                    className="block text-[11px] font-medium text-soft mb-1"
                  >
                    Engine
                  </label>
                  <select
                    id="localEngine"
                    value={localEngine}
                    onChange={(e) => {
                      const newEngine = e.target.value as
                        | "ollama"
                        | "lmstudio"
                        | "llamacpp";
                      setLocalEngine(newEngine);

                      // Smart URL auto-config
                      if (
                        ollamaUrl === "http://localhost:11434" ||
                        ollamaUrl === "http://localhost:1234/v1" ||
                        ollamaUrl === "http://localhost:8080/v1" ||
                        ollamaUrl === "http://127.0.0.1:11434" ||
                        ollamaUrl === "http://127.0.0.1:1234/v1" ||
                        ollamaUrl === "http://127.0.0.1:8080/v1"
                      ) {
                        if (newEngine === "ollama")
                          setOllamaUrl("http://localhost:11434");
                        else if (newEngine === "lmstudio")
                          setOllamaUrl("http://localhost:1234/v1");
                        else if (newEngine === "llamacpp")
                          setOllamaUrl("http://localhost:8080/v1");
                      }
                      setOllamaConnected(null);
                    }}
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs bg-raised focus:ring-brand-mid focus:border-brand-mid"
                  >
                    <option value="ollama">Ollama (Native)</option>
                    <option value="lmstudio">LM Studio / Oobabooga</option>
                    <option value="llamacpp">llama.cpp</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="ollamaUrl"
                    className="block text-[11px] font-medium text-soft mb-1"
                  >
                    API URL
                  </label>
                  <input
                    type="text"
                    id="ollamaUrl"
                    value={ollamaUrl}
                    onChange={(e) => {
                      setOllamaUrl(e.target.value);
                      setOllamaConnected(null);
                    }}
                    className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                    placeholder={
                      localEngine === "ollama"
                        ? "http://localhost:11434"
                        : "http://localhost:1234/v1"
                    }
                  />
                </div>

                {(useOllama || useOllamaForFinal || useOllamaForQueryExpansion) && (
                  <div>
                    <label
                      htmlFor="ollamaModel"
                      className="block text-[11px] font-medium text-soft mb-1"
                    >
                      LLM Model Name
                    </label>
                    {availableModels.length > 0 ? (
                      <select
                        id="ollamaModel"
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                        className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs bg-raised focus:ring-brand-mid focus:border-brand-mid"
                      >
                        {availableModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                        placeholder="Test connection to load models"
                        className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                      />
                    )}
                  </div>
                )}

                {useRag && (
                  <div className="rounded-lg border border-brand-line bg-brand-fog/50 p-2.5 space-y-2.5">
                    <div>
                      <label
                        htmlFor="ragQuery"
                        className="block text-[11px] font-medium text-brand-ink mb-1"
                      >
                        Target Components (RAG Search Query)
                      </label>
                      <input
                        type="text"
                        id="ragQuery"
                        value={ragQuery}
                        onChange={(e) => setRagQuery(e.target.value)}
                        placeholder="e.g., authentication flow, payment gateway…"
                        className="block w-full px-2.5 py-1.5 border border-brand-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid bg-raised"
                      />
                      <p className="mt-1 text-[11px] text-brand-faint leading-tight">
                        Leave empty to auto-generate based on the selected
                        template.
                      </p>
                    </div>
                    <div>
                      <label
                        htmlFor="ragModel"
                        className="block text-[11px] font-medium text-brand-ink mb-1"
                      >
                        Embedding Model (RAG)
                      </label>
                      {availableModels.length > 0 ? (
                        <select
                          id="ragModel"
                          value={ragModel}
                          onChange={(e) => setRagModel(e.target.value)}
                          className="block w-full px-2.5 py-1.5 border border-brand-line rounded-lg text-xs bg-raised focus:ring-brand-mid focus:border-brand-mid"
                        >
                          <option value="" disabled>
                            Select an embedding model…
                          </option>
                          {availableModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={ragModel}
                          onChange={(e) => setRagModel(e.target.value)}
                          placeholder="e.g., nomic-embed-text"
                          className="block w-full px-2.5 py-1.5 border border-brand-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                        />
                      )}
                      <p className="mt-1 text-[11px] text-brand-faint leading-tight">
                        Must be an embedding model (e.g., nomic-embed-text).
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label
                          htmlFor="ragTopK"
                          className="block text-[11px] font-medium text-brand-ink mb-1"
                        >
                          Top K Chunks
                        </label>
                        <input
                          type="number"
                          id="ragTopK"
                          value={ragTopK}
                          onChange={(e) => setRagTopK(Number(e.target.value))}
                          className="block w-full px-2.5 py-1.5 border border-brand-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                          min={1}
                          max={50}
                        />
                      </div>
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-[11px] font-medium text-brand-ink">
                            Strategy
                          </span>
                          <span className="text-[10px] font-mono text-brand-faint bg-brand-soft-2 px-1 rounded">
                            {ragSearchStrategy < 0.4
                              ? "🎨 Explore"
                              : ragSearchStrategy > 0.6
                                ? "🎯 Precision"
                                : "⚖️ Balanced"}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          value={ragSearchStrategy}
                          onChange={(e) =>
                            setRagSearchStrategy(parseFloat(e.target.value))
                          }
                          aria-label="RAG search strategy"
                          className="w-full h-2 bg-brand-line rounded-lg appearance-none cursor-pointer accent-brand"
                        />
                        <div className="flex justify-between text-[10px] text-brand-faint mt-0.5 uppercase tracking-wide font-semibold">
                          <span>Ideas</span>
                          <span>Exact</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {useRag && (
                  <div className="pt-1 border-t border-line-soft">
                    <button
                      type="button"
                      onClick={() => setShowAdvancedRag(!showAdvancedRag)}
                      aria-expanded={showAdvancedRag}
                      className="flex items-center text-xs font-medium text-soft hover:text-body transition-colors"
                    >
                      <Settings2 className="w-3 h-3 mr-1" />
                      Advanced RAG Settings
                      <ChevronDown
                        className={`w-3 h-3 ml-1 transition-transform ${showAdvancedRag ? "rotate-180" : ""}`}
                      />
                    </button>

                    {showAdvancedRag && (
                      <div className="mt-2 space-y-2">
                        <div>
                          <div className="flex justify-between items-center mb-1">
                            <label
                              htmlFor="ragChunkSize"
                              className="text-[11px] font-medium text-brand-ink"
                            >
                              Chunk Size (lines)
                            </label>
                            <span className="text-[10px] font-mono text-brand-faint bg-brand-soft-2 px-1 rounded">
                              {ragChunkSize}
                            </span>
                          </div>
                          <input
                            type="range"
                            id="ragChunkSize"
                            min="10"
                            max="100"
                            step="5"
                            value={ragChunkSize}
                            onChange={(e) =>
                              setRagChunkSize(Number(e.target.value))
                            }
                            className="w-full h-2 bg-brand-line rounded-lg appearance-none cursor-pointer accent-brand"
                          />
                          <div className="flex justify-between text-[10px] text-brand-faint mt-0.5 uppercase tracking-wide font-semibold">
                            <span>Fine</span>
                            <span>Coarse</span>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useQueryExpansion}
                            onChange={(e) =>
                              setUseQueryExpansion(e.target.checked)
                            }
                            className="w-3.5 h-3.5 text-brand border-input-line rounded focus:ring-brand-mid"
                          />
                          <span className="text-[11px] text-mid">
                            AI Query Expansion (synonyms)
                          </span>
                        </label>
                        {useQueryExpansion && (
                          <label className="flex items-center gap-2 cursor-pointer pl-5">
                            <input
                              type="checkbox"
                              checked={useOllamaForQueryExpansion}
                              onChange={(e) =>
                                setUseOllamaForQueryExpansion(e.target.checked)
                              }
                              className="w-3.5 h-3.5 text-brand border-input-line rounded focus:ring-brand-mid"
                            />
                            <span className="text-[11px] text-mid">
                              Use Local Model for Expansion
                            </span>
                          </label>
                        )}
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={useIntentReranking}
                            onChange={(e) =>
                              setUseIntentReranking(e.target.checked)
                            }
                            className="w-3.5 h-3.5 text-brand border-input-line rounded focus:ring-brand-mid"
                          />
                          <span className="text-[11px] text-mid">
                            Intent-Aware Reranking
                          </span>
                        </label>
                        <div className="flex flex-col items-start gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              let count = 0;
                              // Need to collect keys first to avoid modifying while iterating
                              const keysToRemove = [];
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
                              setStatus(
                                `Cleared ${count} cached RAG queries.`,
                              );
                              setTimeout(() => setStatus(""), 3000);
                            }}
                            className="text-[11px] text-danger hover:text-danger-strong font-medium flex items-center"
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Clear RAG Query Cache
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setStatus("Clearing embedding cache...");
                              await EmbeddingCacheService.clearCache();
                              setStatus("Embedding cache cleared.");
                              setTimeout(() => setStatus(""), 3000);
                            }}
                            className="text-[11px] text-danger hover:text-danger-strong font-medium flex items-center"
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Clear Embedding Cache
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(useOllama ||
                  useOllamaForFinal ||
                  useOllamaForQueryExpansion) && (
                  <div className="grid grid-cols-2 gap-2">
                    {localEngine === "ollama" && (
                      <div>
                        <label
                          htmlFor="ollamaNumCtx"
                          className="block text-[11px] font-medium text-soft mb-1"
                          title="1 token ≈ 4 characters. Increase this if the model complains about missing code."
                        >
                          Context Window (Tokens)
                        </label>
                        <input
                          type="number"
                          id="ollamaNumCtx"
                          value={ollamaNumCtx}
                          onChange={(e) =>
                            setOllamaNumCtx(Number(e.target.value))
                          }
                          className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                          min={1024}
                          step={1024}
                        />
                        <p className="mt-1 text-[10px] text-faint leading-tight">
                          More = better code coverage, more RAM/VRAM.
                        </p>
                      </div>
                    )}
                    <div>
                      <label
                        htmlFor="ollamaSummaryPredict"
                        className="block text-[11px] font-medium text-soft mb-1"
                      >
                        Max Tokens (Summary)
                      </label>
                      <input
                        type="number"
                        id="ollamaSummaryPredict"
                        value={ollamaSummaryPredict}
                        onChange={(e) =>
                          setOllamaSummaryPredict(Number(e.target.value))
                        }
                        className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                        min={50}
                        step={50}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="ollamaFinalPredict"
                        className="block text-[11px] font-medium text-soft mb-1"
                      >
                        Max Tokens (Final)
                      </label>
                      <input
                        type="number"
                        id="ollamaFinalPredict"
                        value={ollamaFinalPredict}
                        onChange={(e) =>
                          setOllamaFinalPredict(Number(e.target.value))
                        }
                        className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                        min={250}
                        step={50}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="fileTruncationLimit"
                        className="block text-[11px] font-medium text-soft mb-1"
                        title="0 = No limit (full files). Use 2000-4000 for faster generation when deep code analysis isn't needed."
                      >
                        File Truncation (Chars)
                      </label>
                      <input
                        type="number"
                        id="fileTruncationLimit"
                        value={fileTruncationLimit}
                        onChange={(e) =>
                          setFileTruncationLimit(Number(e.target.value))
                        }
                        className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs focus:ring-brand-mid focus:border-brand-mid"
                        min={0}
                        step={1000}
                      />
                    </div>
                    <div className="col-span-2">
                      <label
                        htmlFor="ollamaTemperature"
                        className="block text-[11px] font-medium text-soft mb-1"
                      >
                        Temperature ({ollamaTemperature})
                      </label>
                      <input
                        type="range"
                        id="ollamaTemperature"
                        value={ollamaTemperature}
                        onChange={(e) =>
                          setOllamaTemperature(Number(e.target.value))
                        }
                        className="w-full accent-brand"
                        min={0}
                        max={1}
                        step={0.1}
                      />
                    </div>
                  </div>
                )}

                {/* Web keeps a manual test (CORS makes auto-checks misleading);
                    desktop auto-checks via the Ollama chip in the top panel */}
                {!isTauri() && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handleTestLocalEngine}
                      disabled={testingOllama}
                      className="text-xs px-2.5 py-1 bg-raised border border-input-line rounded-lg hover:bg-surface-2 transition-colors disabled:opacity-50"
                    >
                      {testingOllama ? "Testing…" : "Test Connection"}
                    </button>
                    {ollamaConnected === true && (
                      <span className="text-[11px] text-ok flex items-center">
                        <Check className="w-3 h-3 mr-1" /> Connected
                      </span>
                    )}
                    {ollamaConnected === false && (
                      <span className="text-[11px] text-danger min-w-0 truncate">
                        Failed (check CORS or server)
                      </span>
                    )}
                  </div>
                )}

                {localEngine === "ollama" && !isTauri() && (
                  <div className="text-[11px] text-soft bg-surface-2 p-2 rounded-lg space-y-1.5">
                    <p>
                      <span className="font-medium text-body">CORS:</span>{" "}
                      start Ollama with{" "}
                      <code className="bg-surface-3 px-1 py-0.5 rounded">
                        OLLAMA_ORIGINS="{window.location.origin}"
                      </code>
                    </p>
                    <button
                      type="button"
                      onClick={handleDownloadBat}
                      className="inline-flex items-center px-2 py-1 bg-brand-fog text-brand-ink border border-brand-line rounded-lg hover:bg-brand-soft-2 transition-colors"
                    >
                      <Download className="w-3 h-3 mr-1" />
                      Download Windows .bat
                    </button>
                  </div>
                )}

                {localEngine !== "ollama" && (
                  <div className="text-[11px] text-soft bg-surface-2 p-2 rounded-lg space-y-1">
                    <p className="font-medium text-body">
                      Manual server start required
                    </p>
                    <p>
                      Launch{" "}
                      {localEngine === "lmstudio"
                        ? "LM Studio / Oobabooga"
                        : "Llama.cpp"}{" "}
                      externally and make sure its API server is listening on
                      the configured URL — the status chip in the top panel
                      re-checks it automatically.
                    </p>
                    {!isTauri() && (
                      <p className="text-warn-strong">
                        CORS must be enabled in your server settings.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </CollapsibleGroup>

          {isTauri() && (
            <CollapsibleGroup
              title="Desktop Settings"
              summary={`v${appVersion || "?"} · ${proxyAddress ? "Proxy set" : "Direct"}`}
              open={!!openGroups.desktop}
              onToggle={() => toggleGroup("desktop")}
            >
              <div>
                <label
                  htmlFor="proxyAddress"
                  className="block text-[11px] font-medium text-soft mb-1"
                >
                  Global Proxy Address (Optional)
                </label>
                <input
                  type="text"
                  id="proxyAddress"
                  value={proxyAddress}
                  onChange={(e) => setProxyAddress(e.target.value)}
                  placeholder="http://127.0.0.1:2080"
                  className="block w-full px-2.5 py-1.5 border border-input-line rounded-lg text-xs"
                />
                <p className="mt-1 text-[10px] text-faint leading-tight">
                  Both "127.0.0.1:2080" and "http://127.0.0.1:2080" are
                  accepted. Leave empty for a guaranteed direct connection.
                </p>
              </div>
            </CollapsibleGroup>
          )}

          {/* Appearance — rarely used, so it lives in the config sidebar */}
          <CollapsibleGroup
            title="Appearance"
            summary={
              theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"
            }
            open={!!openGroups.appearance}
            onToggle={() => toggleGroup("appearance")}
          >
            <div
              className="flex rounded-lg border border-input-line p-0.5"
              role="radiogroup"
              aria-label="Color theme"
            >
              {(
                [
                  { value: "system", label: "System", Icon: Monitor },
                  { value: "light", label: "Light", Icon: Sun },
                  { value: "dark", label: "Dark", Icon: Moon },
                ] as const
              ).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  title={
                    value === "system"
                      ? `Follow the OS (currently: ${
                          window.matchMedia("(prefers-color-scheme: dark)")
                            .matches
                            ? "dark"
                            : "light"
                        })`
                      : undefined
                  }
                  onClick={() => setThemeSetting(value)}
                  className={`flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    theme === value
                      ? "bg-brand-fog text-brand-ink"
                      : "text-soft hover:text-body"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>
          </CollapsibleGroup>

          {/* Danger zone: settings persist in localStorage across sessions */}
          <div className="px-3 py-3">
            <button
              type="button"
              onClick={() => {
                if (
                  !window.confirm(
                    "Reset ALL settings to defaults (providers, API keys, engine and RAG options)? This cannot be undone.",
                  )
                )
                  return;
                localStorage.removeItem("gemini_app_settings");
                window.location.reload();
              }}
              className="text-[11px] font-medium text-danger hover:text-danger-strong transition-colors"
            >
              <Trash2 className="w-3 h-3 mr-1 inline-block -mt-0.5" />
              Reset all settings
            </button>
          </div>
        </aside>

        {/* Right: result */}
        <section
          aria-label="Result"
          className="flex-1 min-w-0 flex flex-col bg-app"
        >
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line bg-surface flex-wrap">
            <FileText className="w-4 h-4 text-faint shrink-0" />
            <h2 className="text-sm font-medium text-ink truncate max-w-[240px]">
              {generatedFileName}
            </h2>
            {restoredAt && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-warn-soft-2 text-warn-strong"
                title="Shown from local history — not a fresh generation"
              >
                <History className="w-3 h-3 mr-1" />
                restored · {new Date(restoredAt).toLocaleString()}
              </span>
            )}
            {usedModel && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-brand-soft-2 text-brand-strong truncate max-w-[180px]">
                {usedModel}
              </span>
            )}
            {lastOptimizedQuery && (
              <div className="flex items-center gap-1 min-w-0">
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-ok-soft-2 text-ok"
                  title="Detected Intent"
                >
                  {lastOptimizedQuery.intent}
                </span>
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-surface-2 text-mid truncate max-w-[160px]"
                  title={`Optimized Query: ${lastOptimizedQuery.query}`}
                >
                  RAG: {lastOptimizedQuery.query}
                </span>
              </div>
            )}
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <div className="relative">
                <button
                  type="button"
                  onClick={handleOpenHistory}
                  aria-expanded={historyOpen}
                  aria-haspopup="true"
                  className="inline-flex items-center px-2.5 py-1.5 border border-input-line shadow-sm text-xs font-medium rounded-lg text-body bg-raised hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-app focus:ring-brand-mid transition-colors"
                >
                  <History className="w-3.5 h-3.5 mr-1.5 text-faint" />
                  History
                  {historyEntries.length > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center px-1.5 min-w-[16px] h-4 rounded-full bg-surface-3 text-[10px] font-semibold text-mid">
                      {historyEntries.length}
                    </span>
                  )}
                </button>
                {historyOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setHistoryOpen(false)}
                      aria-hidden="true"
                    />
                    <div className="absolute right-0 top-full mt-1 w-80 max-h-96 overflow-y-auto bg-surface rounded-xl shadow-lg ring-1 ring-line z-50 py-1">
                      {historyEntries.length === 0 ? (
                        <p className="px-3 py-4 text-center text-xs text-faint">
                          History is empty — generated prompts are saved here
                          automatically.
                        </p>
                      ) : (
                        historyEntries.map((meta) => (
                          <div
                            key={meta.id}
                            className="group flex items-start gap-1 px-2 py-1.5 hover:bg-surface-2"
                          >
                            <button
                              type="button"
                              onClick={() => handleLoadHistoryEntry(meta)}
                              className="flex-1 min-w-0 text-left"
                            >
                              <p className="text-xs font-medium text-ink-2 truncate">
                                {meta.sourceLabel}
                              </p>
                              <p className="text-[11px] text-soft truncate">
                                {meta.templateName} · {meta.model || "—"} ·{" "}
                                {new Date(meta.createdAt).toLocaleString()} ·{" "}
                                {(meta.size / 1024).toFixed(1)} KB
                              </p>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteHistoryEntry(meta.id)}
                              aria-label={`Delete history entry for ${meta.sourceLabel}`}
                              className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 text-faint hover:text-danger transition-opacity"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                      {historyEntries.length > 0 && (
                        <button
                          type="button"
                          onClick={handleClearHistory}
                          className="w-full px-3 py-2 text-left text-[11px] text-danger hover:text-danger-strong hover:bg-danger-soft border-t border-line-soft mt-1"
                        >
                          Clear all history
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={handleCopy}
                className="inline-flex items-center px-2.5 py-1.5 border border-input-line shadow-sm text-xs font-medium rounded-lg text-body bg-raised hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-app focus:ring-brand-mid transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 mr-1.5 text-ok" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 mr-1.5 text-faint" />
                    Copy
                  </>
                )}
              </button>
              <button
                onClick={handleDownload}
                className="inline-flex items-center px-2.5 py-1.5 border border-input-line shadow-sm text-xs font-medium rounded-lg text-body bg-raised hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-app focus:ring-brand-mid transition-colors"
              >
                <Download className="w-3.5 h-3.5 mr-1.5 text-faint" />
                Download
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {prompt ? (
              <pre className="p-4 text-sm font-mono text-ink-2 whitespace-pre-wrap break-words">
                {prompt.length > 50000
                  ? prompt.substring(0, 50000) +
                    '\n\n... [⚠️ PREVIEW TRUNCATED FOR PERFORMANCE ⚠️]\n... [The full prompt is too large to display in the browser without lagging.]\n... [Please use the "Copy" or "Download" buttons above to get the full text.]'
                  : prompt}
              </pre>
            ) : (
              <div
                className="h-full flex flex-col items-center justify-center text-center p-8"
                role="status"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-8 h-8 text-brand-faint animate-spin mb-3" />
                    <p className="text-sm font-medium text-soft">
                      Generating…
                    </p>
                    <p className="text-xs text-faint mt-1">
                      Progress is shown in the status bar above. You can keep
                      editing templates and settings meanwhile.
                    </p>
                  </>
                ) : (
                  <>
                    <FileText className="w-10 h-10 text-faint mb-3" />
                    <p className="text-sm font-medium text-soft">
                      The generated prompt will appear here
                    </p>
                    <p className="text-xs text-faint mt-1 max-w-xs">
                      Pick a source and a template above, then press Generate
                      Prompt. Recent generations are available under History.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Token Warning Modal */}
      {tokenWarningResolver && tokenWarning && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-surface rounded-2xl shadow-xl max-w-lg w-full p-6">
            <div className="flex items-center gap-3 text-warn mb-4">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="text-lg font-semibold text-ink">
                Context Limits Conflict
              </h3>
            </div>
            <div className="text-sm text-mid space-y-3 mb-6">
              <p>
                Your input prompt (code + instructions) is approximately{" "}
                <strong>~{tokenWarning.inputTokens} tokens</strong>.
              </p>
              <p>
                With your current <code>Context Window</code> ({ollamaNumCtx}),
                only <strong>~{tokenWarning.availableTokens} tokens</strong>{" "}
                remain for the model's response.
              </p>
              <p>
                However, you requested <code>Max Tokens (Final)</code> ={" "}
                {tokenWarning.requestedTokens}.
              </p>
              <div className="bg-warn-soft border border-warn-line p-3 rounded-lg text-warn-strong">
                If you proceed, Ollama will{" "}
                <strong>truncate the beginning of your prompt</strong> (the
                system instructions) to fit the limits, which may cause the
                model to ignore your formatting rules or task description.
              </div>
              <p className="font-medium text-ink mt-4">
                Recommendations:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Increase <code>Context Window</code> to{" "}
                  {tokenWarning.inputTokens +
                    tokenWarning.requestedTokens +
                    500}{" "}
                  (if your RAM allows).
                </li>
                <li>
                  Or decrease <code>Max Tokens (Final)</code> to{" "}
                  {Math.max(500, tokenWarning.availableTokens - 200)}.
                </li>
              </ul>
              <div className="mt-4 bg-danger-soft border border-danger-line p-3 rounded-lg text-danger-strong text-xs">
                <strong>⚠️ Hardware Warning:</strong> The{" "}
                <code>Context Window</code> is passed directly to Ollama,
                overriding its default. Setting it to 20,000+ tokens requires
                massive amounts of RAM/VRAM (especially for 24B+ models). If
                your system (e.g., 16GB/32GB RAM) cannot allocate the KV cache,
                Ollama may crash, freeze your system, or return an Out Of Memory
                error.
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-3 justify-end">
              <button
                onClick={() => tokenWarningResolver(false)}
                className="px-4 py-2 text-sm font-medium text-body bg-surface-2 hover:bg-surface-3 rounded-lg transition-colors"
              >
                Cancel (Change Settings)
              </button>
              <button
                onClick={() => tokenWarningResolver(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-warn-solid hover:bg-warn-solid-2 rounded-lg transition-colors"
              >
                Proceed with Truncation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
