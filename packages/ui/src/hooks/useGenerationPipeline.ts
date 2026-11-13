import React, { useRef, useState } from "react";
import {
  EmbeddingCacheService,
  RepoData,
  buildPromptText,
  fetchRepoData,
  generatePrompt,
  generate_final_prompt_with_ollama,
  generate_final_prompt_with_openai_compatible,
  getTemplate,
  isTauri,
  performRAG,
  pickLocalDirectoryNative,
  processLocalFolder,
  processNativeLocalFolder,
  rewriteQuery,
  rewriteQueryWithOllama,
  rewriteQueryWithOpenAICompatible,
  saveMarkdownFile,
  summarize_with_ollama,
} from "@repo-prompt-generator/core";
import { OptimizedQueryInfo, TokenWarningState } from "../types/ui";
import { useAppSettings } from "./useAppSettings";

function wrapMarkdownBlockquoteFence(
  text: string,
  lang: string = "text",
): string {
  const matches = text.match(/`+/g);
  const maxRun = matches ? Math.max(...matches.map((m) => m.length)) : 0;
  const fence = "`".repeat(Math.max(4, maxRun + 1));
  const lines = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> ${fence}${lang}\n${lines}\n> ${fence}\n`;
}

export function useGenerationPipeline(
  settings: ReturnType<typeof useAppSettings>,
) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [lastOptimizedQuery, setLastOptimizedQuery] =
    useState<OptimizedQueryInfo | null>(null);
  const [generatedFileName, setGeneratedFileName] =
    useState<string>("gemini.md");
  const [copied, setCopied] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const [ragWarning, setRagWarning] = useState<string | null>(null);

  const [cachedRepoData, setCachedRepoData] = useState<RepoData | null>(null);
  const [cacheKey, setCacheKey] = useState<string>("");
  const [cachedReferenceRepoData, setCachedReferenceRepoData] =
    useState<RepoData | null>(null);
  const [referenceCacheKey, setReferenceCacheKey] = useState<string>("");

  const [tokenWarningResolver, setTokenWarningResolver] = useState<
    ((proceed: boolean) => void) | null
  >(null);
  const [tokenWarning, setTokenWarning] = useState<TokenWarningState | null>(
    null,
  );

  const abortControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  const currentGithubCacheKey = `${settings.url}-${settings.githubToken}-${settings.maxFiles}`;
  const isRegenerateCached =
    settings.inputMode === "github" &&
    Boolean(cachedRepoData) &&
    cacheKey === currentGithubCacheKey;

  const hasValidLocalTarget = isTauri()
    ? Boolean(settings.nativeLocalPath) ||
      Boolean(settings.localFiles && settings.localFiles.length > 0)
    : Boolean(settings.localFiles && settings.localFiles.length > 0);

  const canGenerate =
    !loading &&
    (settings.inputMode === "github"
      ? Boolean(settings.url.trim())
      : hasValidLocalTarget);

  const handlePickNativeFolder = async (target: "main" | "reference") => {
    const picked = await pickLocalDirectoryNative(
      target === "main"
        ? "Select Target Repository Folder"
        : "Select Reference Repository Folder",
    );
    if (!picked) return;
    if (target === "main") {
      settings.setNativeLocalPath(picked);
      setCachedRepoData(null);
      setCacheKey("");
    } else {
      settings.setReferenceNativeLocalPath(picked);
      setCachedReferenceRepoData(null);
      setReferenceCacheKey("");
    }
  };

  const cancelGeneration = () => {
    runIdRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (tokenWarningResolver) {
      tokenWarningResolver(false);
      setTokenWarning(null);
      setTokenWarningResolver(null);
    }
    setLoading(false);
    setStatus("Generation cancelled by user.");
  };

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (settings.inputMode === "github" && !settings.url.trim()) return;
    if (settings.inputMode === "local" && !hasValidLocalTarget) return;

    if (settings.useRag && !settings.ragModel.trim()) {
      setError(
        "Please select or enter an Embedding Model for RAG. It is required to process the repository files.",
      );
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const myRunId = ++runIdRef.current;
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    const ensureActive = () => {
      if (signal.aborted || runIdRef.current !== myRunId) {
        throw new DOMException("Generation cancelled", "AbortError");
      }
    };

    setLoading(true);
    setError(null);
    setPrompt(null);
    setUsedModel(null);
    setLastOptimizedQuery(null);
    setCopied(false);
    setIsTruncated(false);
    setRagWarning(null);

    try {
      let repoData: RepoData;

      if (settings.inputMode === "github") {
        if (cachedRepoData && cacheKey === currentGithubCacheKey) {
          setStatus("Using cached repository data...");
          repoData = cachedRepoData;
        } else {
          setStatus("Fetching repository data...");
          repoData = await fetchRepoData(
            settings.url,
            settings.githubToken,
            settings.maxFiles,
            signal,
          );
          ensureActive();
          setCachedRepoData(repoData);
          setCacheKey(currentGithubCacheKey);
        }
      } else if (isTauri() && settings.nativeLocalPath) {
        setStatus("Scanning native local repository...");
        repoData = await processNativeLocalFolder(
          settings.nativeLocalPath,
          settings.maxFiles,
        );
        ensureActive();
        setCachedRepoData(null);
        setCacheKey("");
      } else {
        setStatus("Processing local files...");
        repoData = await processLocalFolder(
          settings.localFiles!,
          settings.maxFiles,
        );
        ensureActive();
        setCachedRepoData(null);
        setCacheKey("");
      }

      if (repoData.isTruncated) {
        setIsTruncated(true);
      }

      const projectName = repoData.info?.repo || "project";
      const templateName =
        settings.templateMode === "default" ? "gemini" : settings.templateMode;
      const date = new Date();
      const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;

      let referenceRepoData: RepoData | undefined;
      const isCustomMode =
        settings.templateMode === "custom" ||
        settings.templateMode.startsWith("user_");
      const shouldFetchReference =
        settings.templateMode === "integration" ||
        (isCustomMode && settings.useReferenceRepo);

      if (shouldFetchReference) {
        if (
          settings.referenceInputMode === "github" &&
          settings.referenceUrl.trim()
        ) {
          const currentRefCacheKey = `${settings.referenceUrl}-${settings.githubToken}-${settings.referenceMaxFiles}`;
          if (
            cachedReferenceRepoData &&
            referenceCacheKey === currentRefCacheKey
          ) {
            setStatus("Using cached reference repository data...");
            referenceRepoData = cachedReferenceRepoData;
          } else {
            setStatus("Fetching reference repository data...");
            referenceRepoData = await fetchRepoData(
              settings.referenceUrl,
              settings.githubToken,
              settings.referenceMaxFiles,
              signal,
            );
            ensureActive();
            setCachedReferenceRepoData(referenceRepoData);
            setReferenceCacheKey(currentRefCacheKey);
          }
        } else if (settings.referenceInputMode === "local") {
          if (isTauri() && settings.referenceNativeLocalPath) {
            setStatus("Scanning native reference folder...");
            referenceRepoData = await processNativeLocalFolder(
              settings.referenceNativeLocalPath,
              settings.referenceMaxFiles,
            );
            ensureActive();
            setCachedReferenceRepoData(null);
            setReferenceCacheKey("");
          } else if (
            settings.referenceLocalFiles &&
            settings.referenceLocalFiles.length > 0
          ) {
            setStatus("Processing local reference files...");
            referenceRepoData = await processLocalFolder(
              settings.referenceLocalFiles,
              settings.referenceMaxFiles,
            );
            ensureActive();
            setCachedReferenceRepoData(null);
            setReferenceCacheKey("");
          }
        }

        if (referenceRepoData?.isTruncated) {
          setIsTruncated(true);
        }
      }

      const targetRepoIdentifier =
        settings.inputMode === "local"
          ? `local://${repoData.info.repo}`
          : settings.url;
      const refRepoIdentifier = referenceRepoData
        ? settings.referenceInputMode === "local"
          ? `local://${referenceRepoData.info.repo}`
          : settings.referenceUrl
        : "";
      const engineName =
        settings.localEngine === "ollama"
          ? "Ollama"
          : settings.localEngine === "lmstudio"
            ? "LM Studio"
            : "Llama.cpp";

      let finalUsedRagQuery = "";
      let finalUsedOptimizedQuery = "";

      if (
        settings.useRag &&
        repoData.sourceFiles &&
        repoData.sourceFiles.length > 0
      ) {
        try {
          await EmbeddingCacheService.pruneUnusedCaches(
            [targetRepoIdentifier, refRepoIdentifier].filter(Boolean),
          );
          ensureActive();

          const getFallbackQuery = () => {
            const template = getTemplate(settings.templateMode);
            let query = template
              ? template.defaultSearchQuery
              : settings.customInstruction.substring(0, 500);

            if (settings.additionalContext.trim()) {
              query += `\n\nSpecific Task Context: ${settings.additionalContext.substring(0, 500)}`;
            }
            if (settings.attachedDocs.length > 0) {
              const docNames = settings.attachedDocs
                .map((d) => d.name)
                .join(", ");
              query += `\n\nAttached Documents: ${docNames}`;
            }
            return query;
          };

          const baseQuery =
            settings.ragQuery.trim() !== ""
              ? settings.ragQuery
              : getFallbackQuery();
          let optimizedQuery = baseQuery;
          let queryIntent = "GENERAL";
          let optimizedQueryInfo: OptimizedQueryInfo | null = null;

          const hasExtraContext =
            settings.additionalContext.trim() !== "" ||
            settings.attachedDocs.length > 0;
          const isStandardTemplateDefault =
            settings.ragQuery.trim() === "" &&
            getTemplate(settings.templateMode) !== undefined &&
            !hasExtraContext;

          if (
            (settings.useQueryExpansion || settings.useIntentReranking) &&
            !isStandardTemplateDefault
          ) {
            setStatus("Optimizing RAG query with LLM...");
            try {
              const queryHash =
                baseQuery.length +
                "_" +
                baseQuery.substring(0, 30) +
                "_" +
                baseQuery.substring(baseQuery.length - 30);
              const contextHash =
                settings.additionalContext.length +
                "_" +
                settings.additionalContext.substring(0, 20);
              const optCacheKey = `rag_opt_${settings.aiProvider}_${settings.templateMode}_${queryHash}_${contextHash}`;
              const cached = localStorage.getItem(optCacheKey);

              if (cached) {
                const parsed = JSON.parse(cached);
                if (settings.useQueryExpansion) {
                  optimizedQuery = parsed.optimizedQuery;
                  setStatus(`RAG query optimized (cached): ${optimizedQuery}`);
                }
                if (settings.useIntentReranking) {
                  queryIntent = parsed.intent;
                }
                optimizedQueryInfo = {
                  query: optimizedQuery,
                  intent: queryIntent,
                };
                setLastOptimizedQuery(optimizedQueryInfo);
              } else {
                let result;
                if (settings.useOllamaForQueryExpansion) {
                  if (settings.localEngine === "ollama") {
                    result = await rewriteQueryWithOllama(
                      baseQuery,
                      settings.ollamaUrl,
                      settings.ollamaModel,
                      signal,
                    );
                  } else {
                    result = await rewriteQueryWithOpenAICompatible(
                      baseQuery,
                      settings.ollamaUrl,
                      "sk-dummy-key",
                      settings.ollamaModel,
                      signal,
                    );
                  }
                } else {
                  result = await rewriteQuery(settings.aiProvider, baseQuery, {
                    customBaseUrl: settings.customBaseUrl,
                    customApiKey: settings.customApiKey,
                    customModel: settings.customModel,
                    geminiApiKey: settings.geminiApiKey,
                    proxyAddress: settings.proxyAddress,
                    signal,
                  });
                }
                ensureActive();

                if (settings.useQueryExpansion) {
                  optimizedQuery = result.optimizedQuery;
                  setStatus(`RAG query optimized: ${optimizedQuery}`);
                }
                if (settings.useIntentReranking) {
                  queryIntent = result.intent;
                }

                if (!("isFallback" in result && result.isFallback)) {
                  localStorage.setItem(
                    optCacheKey,
                    JSON.stringify({
                      optimizedQuery: result.optimizedQuery,
                      intent: result.intent,
                    }),
                  );
                }
                optimizedQueryInfo = {
                  query: optimizedQuery,
                  intent: queryIntent,
                };
                setLastOptimizedQuery(optimizedQueryInfo);
              }
            } catch (err: any) {
              if (
                err?.name === "AbortError" ||
                signal.aborted ||
                runIdRef.current !== myRunId
              ) {
                throw err;
              }
              console.warn(
                "Query optimization failed, using original query",
                err,
              );
              optimizedQueryInfo = null;
              setLastOptimizedQuery(null);
            }
          } else {
            if (isStandardTemplateDefault && settings.useIntentReranking) {
              if (
                settings.templateMode === "audit" ||
                settings.templateMode === "security"
              ) {
                queryIntent = "BUG_HUNT";
              } else if (
                settings.templateMode === "architecture" ||
                settings.templateMode === "integration"
              ) {
                queryIntent = "ARCHITECTURE";
              } else if (
                settings.templateMode === "docs" ||
                settings.templateMode === "eli5"
              ) {
                queryIntent = "GENERAL";
              }
            }
            optimizedQueryInfo = {
              query: optimizedQuery,
              intent: queryIntent,
            };
            setLastOptimizedQuery(optimizedQueryInfo);
          }

          const finalRagQuery = optimizedQuery.substring(0, 1000);
          finalUsedRagQuery = settings.ragQuery;
          finalUsedOptimizedQuery = finalRagQuery;

          if (!optimizedQueryInfo || optimizedQueryInfo.query.trim() === "") {
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
            settings.ollamaUrl,
            settings.ragModel,
            targetRepoIdentifier,
            settings.ragTopK,
            settings.ragSearchStrategy,
            settings.ragChunkSize,
            (msg) => {
              if (runIdRef.current === myRunId) setStatus(msg);
            },
            settings.localEngine,
            signal,
            (warnMsg) => {
              if (runIdRef.current === myRunId) setRagWarning(warnMsg);
            },
          );
          ensureActive();
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
              settings.ollamaUrl,
              settings.ragModel,
              refRepoIdentifier,
              settings.ragTopK,
              settings.ragSearchStrategy,
              settings.ragChunkSize,
              (msg) => {
                if (runIdRef.current === myRunId) setStatus(msg);
              },
              settings.localEngine,
              signal,
              (warnMsg) => {
                if (runIdRef.current === myRunId) setRagWarning(warnMsg);
              },
            );
            ensureActive();
            referenceRepoData = {
              ...referenceRepoData,
              sourceFiles: refRagFiles,
            };
          }
        } catch (err: any) {
          if (
            err?.name === "AbortError" ||
            signal.aborted ||
            runIdRef.current !== myRunId
          ) {
            throw err;
          }
          setError(`RAG failed: ${err.message}`);
          return;
        }
      }

      let usedOllama = false;
      if (settings.useOllama && settings.ollamaConnected !== false) {
        setStatus(`Summarizing with ${engineName}...`);
        usedOllama = true;

        const summarize = async (text: string) => {
          ensureActive();
          if (!text) return "";
          if (settings.localEngine === "ollama") {
            return await summarize_with_ollama(
              text,
              settings.ollamaUrl,
              settings.ollamaModel,
              settings.ollamaNumCtx,
              settings.ollamaSummaryPredict,
              settings.ollamaTemperature,
              signal,
            );
          } else {
            const summaryPrompt = `Please summarize the following file content in a few sentences, extracting only the most important information relevant for understanding the architecture, purpose, and key logic of the code. Ignore boilerplate.\n\nContent:\n${text.substring(0, 8000)}`;
            return await generate_final_prompt_with_openai_compatible(
              summaryPrompt,
              settings.ollamaUrl,
              "sk-dummy-key",
              settings.ollamaModel,
              settings.ollamaTemperature,
              signal,
            );
          }
        };

        const summarizedSourceFiles = [];
        if (repoData.sourceFiles) {
          for (const file of repoData.sourceFiles) {
            ensureActive();
            setStatus(`Summarizing ${file.path} with ${engineName}...`);
            const summary = await summarize(file.content);
            ensureActive();
            summarizedSourceFiles.push({ path: file.path, content: summary });
          }
        }

        const summarizedReadme = await summarize(repoData.readme);
        ensureActive();
        const summarizedDeps = await summarize(repoData.dependencies);
        ensureActive();

        repoData = {
          ...repoData,
          readme: summarizedReadme,
          dependencies: summarizedDeps,
          sourceFiles: summarizedSourceFiles,
        };

        if (referenceRepoData) {
          const refSummarizedSourceFiles = [];
          if (referenceRepoData.sourceFiles) {
            for (const file of referenceRepoData.sourceFiles) {
              ensureActive();
              setStatus(
                `Summarizing reference ${file.path} with ${engineName}...`,
              );
              const summary = await summarize(file.content);
              ensureActive();
              refSummarizedSourceFiles.push({
                path: file.path,
                content: summary,
              });
            }
          }
          const refReadme = await summarize(referenceRepoData.readme);
          ensureActive();
          const refDeps = await summarize(referenceRepoData.dependencies);
          ensureActive();

          referenceRepoData = {
            ...referenceRepoData,
            readme: refReadme,
            dependencies: refDeps,
            sourceFiles: refSummarizedSourceFiles,
          };
        }
      }

      ensureActive();
      let generatedPrompt = "";
      let finalModel = "";
      let requestedFiles: string[] = [];
      let fetchedFilesCount: number | undefined = undefined;
      const taskInstruction = settings.getSystemPrompt(
        settings.templateMode,
        settings.customInstruction,
      );

      if (settings.useOllamaForFinal && settings.ollamaConnected !== false) {
        setStatus(`Generating final prompt with local ${engineName}...`);
        const promptText = buildPromptText(
          repoData,
          taskInstruction,
          settings.additionalContext,
          settings.analyzeIssues,
          referenceRepoData,
          settings.attachedDocs,
          settings.fileTruncationLimit,
        );

        const inputTokens = Math.ceil(promptText.length / 4);
        const availableTokens = settings.ollamaNumCtx - inputTokens;

        if (
          settings.localEngine === "ollama" &&
          availableTokens < settings.ollamaFinalPredict
        ) {
          const proceed = await new Promise<boolean>((resolve) => {
            setTokenWarning({
              inputTokens,
              availableTokens,
              requestedTokens: settings.ollamaFinalPredict,
              promptText,
            });
            setTokenWarningResolver(() => resolve);
          });

          setTokenWarning(null);
          setTokenWarningResolver(null);
          ensureActive();

          if (!proceed) {
            return;
          }
        }

        if (settings.localEngine === "ollama") {
          generatedPrompt = await generate_final_prompt_with_ollama(
            promptText,
            settings.ollamaUrl,
            settings.ollamaModel,
            settings.ollamaNumCtx,
            settings.ollamaFinalPredict,
            settings.ollamaTemperature,
            signal,
          );
        } else {
          generatedPrompt = await generate_final_prompt_with_openai_compatible(
            promptText,
            settings.ollamaUrl,
            "sk-dummy-key",
            settings.ollamaModel,
            settings.ollamaTemperature,
            signal,
          );
        }
        ensureActive();
        finalModel = `${engineName} (${settings.ollamaModel})`;
      } else {
        setStatus(
          settings.aiProvider === "gemini"
            ? `Generating system prompt with ${settings.geminiModel}...`
            : `Generating system prompt with ${settings.customModel || "custom"}...`,
        );
        const result = await generatePrompt(
          settings.aiProvider,
          repoData,
          taskInstruction,
          settings.additionalContext,
          settings.analyzeIssues,
          usedOllama,
          referenceRepoData,
          settings.attachedDocs,
          {
            customBaseUrl: settings.customBaseUrl,
            customApiKey: settings.customApiKey,
            customModel: settings.customModel,
            fileTruncationLimit: settings.fileTruncationLimit,
            geminiApiKey: settings.geminiApiKey,
            geminiModel: settings.geminiModel,
            geminiThinkingLevel: settings.geminiThinkingLevel,
            proxyAddress: settings.proxyAddress,
            isDeepAnalysis: settings.isDeepAnalysis,
            onStatusUpdate: (msg) => {
              if (runIdRef.current === myRunId) setStatus(msg);
            },
            localFiles:
              settings.inputMode === "local" ? settings.localFiles : undefined,
            referenceLocalFiles:
              settings.referenceInputMode === "local"
                ? settings.referenceLocalFiles
                : undefined,
            githubToken: settings.githubToken,
            temperature: settings.ollamaTemperature,
            signal,
          },
        );
        ensureActive();
        generatedPrompt = result.text;
        finalModel = result.modelVersion;
        if (result.requestedFiles) {
          requestedFiles = result.requestedFiles;
          fetchedFilesCount = result.fetchedFilesCount;
        }
      }

      let metadata = `> **Prompt Generation Metadata**\n`;
      metadata += `> - **Model:** ${finalModel}\n`;
      if (settings.aiProvider === "gemini" && !settings.useOllamaForFinal) {
        metadata += `> - **Thinking Level:** ${settings.geminiThinkingLevel}\n`;
      }
      metadata += `> - **Target Repository:** ${
        settings.inputMode === "local"
          ? `Local Folder (${repoData.info.repo})`
          : settings.url
      }\n`;
      if (referenceRepoData) {
        if (settings.referenceInputMode === "local") {
          metadata += `> - **Reference Repository:** Local Folder (${referenceRepoData.info.repo})\n`;
        } else if (settings.referenceUrl) {
          metadata += `> - **Reference Repository:** ${settings.referenceUrl}\n`;
        }
      }

      if (settings.useRag) {
        const formatSingleLine = (val: string) =>
          val.replace(/\s+/g, " ").trim();
        if (finalUsedRagQuery) {
          metadata += `> - **Original RAG Query:** "${formatSingleLine(finalUsedRagQuery)}"\n`;
          if (
            finalUsedOptimizedQuery &&
            finalUsedOptimizedQuery !== finalUsedRagQuery
          ) {
            metadata += `> - **Optimized RAG Query:** "${formatSingleLine(finalUsedOptimizedQuery)}"\n`;
          }
        } else {
          metadata += `> - **Auto-generated RAG Query:** "${formatSingleLine(finalUsedOptimizedQuery || "Unknown")}"\n`;
        }
      }
      if (usedOllama) {
        metadata += `> - **Pre-processing:** Local LLM (${engineName})\n`;
      }

      if (requestedFiles.length > 0) {
        if (fetchedFilesCount !== undefined) {
          metadata += `> - **Agentic RAG Requested Files:** (${fetchedFilesCount}/${requestedFiles.length} fetched)\n`;
        } else {
          metadata += `> - **Agentic RAG Requested Files:**\n`;
        }
        requestedFiles.forEach((file) => {
          metadata += `>   - \`${file}\`\n`;
        });
      }

      metadata += `> \n`;
      metadata += `> <details><summary><b>Task Instructions</b></summary>\n> \n`;
      metadata += wrapMarkdownBlockquoteFence(taskInstruction, "text");
      metadata += `> </details>\n`;

      if (settings.additionalContext) {
        metadata += `>\n> <details><summary><b>Additional Context</b></summary>\n> \n`;
        metadata += wrapMarkdownBlockquoteFence(
          settings.additionalContext,
          "text",
        );
        metadata += `> </details>\n`;
      }

      metadata += `\n---\n\n`;

      generatedPrompt = metadata + generatedPrompt;

      const safeProjectName =
        projectName
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "project";
      const safeModelName = finalModel
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .toLowerCase();
      setGeneratedFileName(
        `${safeProjectName}_${templateName}_${safeModelName}_${timestamp}.md`,
      );

      setPrompt(generatedPrompt);
      setUsedModel(finalModel);
    } catch (err: any) {
      if (
        err?.name === "AbortError" ||
        signal.aborted ||
        runIdRef.current !== myRunId
      ) {
        return;
      }
      setError(err.message || "An unexpected error occurred.");
    } finally {
      if (runIdRef.current === myRunId) {
        setLoading(false);
        setStatus("");
      }
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

  return {
    loading,
    status,
    setStatus,
    error,
    setError,
    prompt,
    usedModel,
    lastOptimizedQuery,
    generatedFileName,
    copied,
    isTruncated,
    ragWarning,
    setRagWarning,
    tokenWarning,
    tokenWarningResolver,
    isRegenerateCached,
    canGenerate,
    handlePickNativeFolder,
    handleGenerate,
    cancelGeneration,
    handleCopy,
    handleDownload,
  };
}
