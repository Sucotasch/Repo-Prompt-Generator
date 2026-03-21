import React, { useState, useEffect } from 'react';
import { Github, FileText, Loader2, Copy, Check, Download, Settings2, AlertTriangle, Save, Trash2, Folder, ChevronDown, Database, Paperclip, X } from 'lucide-react';
import { fetchRepoData } from './services/githubService';
import { processLocalFolder } from './services/localFileService';
import { generateSystemPrompt, buildPromptText, rewriteQueryWithGemini } from './services/geminiService';
import { checkOllamaConnection, summarize_with_ollama, fetchOllamaModels, generate_final_prompt_with_ollama, rewriteQueryWithOllama } from './services/ollamaService';
import { fetchOpenAICompatibleModels } from './services/openaiCompatibleService';
import { generatePrompt, rewriteQuery, AIProvider } from './services/aiAdapter';
import { EmbeddingCacheService } from './services/embeddingCacheService';
import { performRAG } from './services/ragService';
import { startDeviceAuth, pollDeviceToken } from './services/qwenAuthService';
import { getTemplate, getAllTemplates } from './templates';
import { saveMarkdownFile } from './utils/fileSystem';

interface SavedTemplate {
  id: string;
  name: string;
  content: string;
}

export default function App() {
  const [url, setUrl] = useState('');
  
  // Load settings from localStorage
  const initialSettings = (() => {
    try {
      const saved = localStorage.getItem('gemini_app_settings');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  })();

  const [githubToken, setGithubToken] = useState(initialSettings.githubToken || '');
  const [maxFiles, setMaxFiles] = useState(initialSettings.maxFiles || 5);
  const [inputMode, setInputMode] = useState<'github' | 'local'>(initialSettings.inputMode || 'github');
  const [localFiles, setLocalFiles] = useState<FileList | null>(null);
  
  // Reference Repository State
  const [referenceInputMode, setReferenceInputMode] = useState<'github' | 'local'>('github');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [referenceLocalFiles, setReferenceLocalFiles] = useState<FileList | null>(null);
  const [referenceMaxFiles, setReferenceMaxFiles] = useState(initialSettings.maxFiles || 5);
  const [cachedReferenceRepoData, setCachedReferenceRepoData] = useState<any>(null);
  const [referenceCacheKey, setReferenceCacheKey] = useState<string>('');
  const [useReferenceRepo, setUseReferenceRepo] = useState(false);

  const [templateMode, setTemplateMode] = useState<string>('default');
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    try {
      const saved = localStorage.getItem('gemini_custom_templates');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [customInstruction, setCustomInstruction] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [ragQuery, setRagQuery] = useState('');
  const [attachedDocs, setAttachedDocs] = useState<{name: string, content: string}[]>([]);
  const [analyzeIssues, setAnalyzeIssues] = useState(false);
  const [useOllama, setUseOllama] = useState(initialSettings.useOllama || false);
  const [useOllamaForFinal, setUseOllamaForFinal] = useState(initialSettings.useOllamaForFinal || false);
  const [aiProvider, setAiProvider] = useState<AIProvider>(initialSettings.aiProvider || 'gemini');
  const [qwenOAuthToken, setQwenOAuthToken] = useState(initialSettings.qwenOAuthToken || '');
  const [qwenResourceUrl, setQwenResourceUrl] = useState(initialSettings.qwenResourceUrl || '');
  const [qwenAuthStatus, setQwenAuthStatus] = useState<'idle' | 'polling' | 'success' | 'error'>('idle');
  const [qwenAuthUrl, setQwenAuthUrl] = useState<string | null>(null);
  const [qwenAuthMessage, setQwenAuthMessage] = useState<string>('');
  const [qwenRateLimit, setQwenRateLimit] = useState<{remainingRequests: string, resetRequests: string, remainingTokens: string, resetTokens: string} | null>(null);
  const [useRag, setUseRag] = useState(initialSettings.useRag || false);
  const [ragModel, setRagModel] = useState(initialSettings.ragModel || '');
  const [ragTopK, setRagTopK] = useState(initialSettings.ragTopK || 10);
  const [ragSearchStrategy, setRagSearchStrategy] = useState(initialSettings.ragSearchStrategy !== undefined ? initialSettings.ragSearchStrategy : 0.5);
  const [ollamaUrl, setOllamaUrl] = useState(initialSettings.ollamaUrl || 'http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState(initialSettings.ollamaModel || 'llama3');
  const [ollamaNumCtx, setOllamaNumCtx] = useState(initialSettings.ollamaNumCtx || 8192);
  const [ollamaSummaryPredict, setOllamaSummaryPredict] = useState(initialSettings.ollamaSummaryPredict || 500);
  const [ollamaFinalPredict, setOllamaFinalPredict] = useState(initialSettings.ollamaFinalPredict || 2000);
  const [fileTruncationLimit, setFileTruncationLimit] = useState(initialSettings.fileTruncationLimit !== undefined ? initialSettings.fileTruncationLimit : 2000);
  const [ollamaTemperature, setOllamaTemperature] = useState(initialSettings.ollamaTemperature !== undefined ? initialSettings.ollamaTemperature : 0.3);
  const [useQueryExpansion, setUseQueryExpansion] = useState(initialSettings.useQueryExpansion !== undefined ? initialSettings.useQueryExpansion : true);
  const [useIntentReranking, setUseIntentReranking] = useState(initialSettings.useIntentReranking !== undefined ? initialSettings.useIntentReranking : true);
  
  // Custom API Provider State
  const [customBaseUrl, setCustomBaseUrl] = useState(initialSettings.customBaseUrl || '');
  const [customApiKey, setCustomApiKey] = useState(initialSettings.customApiKey || '');
  const [customModel, setCustomModel] = useState(initialSettings.customModel || '');
  const [availableCustomModels, setAvailableCustomModels] = useState<string[]>([]);
  const [testingCustomProvider, setTestingCustomProvider] = useState(false);
  const [customProviderConnected, setCustomProviderConnected] = useState<boolean | null>(null);
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);

  const [showAdvancedRag, setShowAdvancedRag] = useState(false);
  
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testingOllama, setTestingOllama] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [usedModel, setUsedModel] = useState<string | null>(null);
  const [lastOptimizedQuery, setLastOptimizedQuery] = useState<{query: string, intent: string} | null>(null);
  const [generatedFileName, setGeneratedFileName] = useState<string>('gemini.md');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');
  const [isTruncated, setIsTruncated] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [isSavingNew, setIsSavingNew] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  
  const [tokenWarningResolver, setTokenWarningResolver] = useState<((proceed: boolean) => void) | null>(null);
  const [tokenWarning, setTokenWarning] = useState<{
    inputTokens: number;
    availableTokens: number;
    requestedTokens: number;
    promptText: string;
  } | null>(null);
  
  // Cache state
  const [cachedRepoData, setCachedRepoData] = useState<any>(null);
  const [cacheKey, setCacheKey] = useState<string>('');

  // Auto-clear RAG query optimization cache when repo or template changes
  // AND Prune unused embedding caches
  useEffect(() => {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('rag_opt_')) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      console.log(`[Auto-Clear] Repo/Template changed. Clearing ${keysToRemove.length} stale RAG query optimizations.`);
      keysToRemove.forEach(key => localStorage.removeItem(key));
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
      aiProvider,
      qwenOAuthToken,
      qwenResourceUrl,
      useRag,
      ragModel,
      ragTopK,
      ragSearchStrategy,
      ollamaUrl,
      ollamaModel,
      ollamaNumCtx,
      ollamaSummaryPredict,
      ollamaFinalPredict,
      fileTruncationLimit,
      ollamaTemperature,
      useQueryExpansion,
      useIntentReranking,
      customBaseUrl,
      customApiKey,
      customModel
    };
    localStorage.setItem('gemini_app_settings', JSON.stringify(settings));
  }, [inputMode, githubToken, maxFiles, useOllama, useOllamaForFinal, aiProvider, qwenOAuthToken, qwenResourceUrl, useRag, ragModel, ragTopK, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaSummaryPredict, ollamaFinalPredict, fileTruncationLimit, ollamaTemperature, useQueryExpansion, useIntentReranking, customBaseUrl, customApiKey, customModel, ragSearchStrategy]);

  const handleTemplateChange = (mode: string) => {
    setTemplateMode(mode);
    if (mode === 'custom') {
      setCustomInstruction('');
    } else {
      const tpl = savedTemplates.find(t => t.id === mode);
      if (tpl) setCustomInstruction(tpl.content);
    }
  };

  const handleSaveTemplate = (e: React.MouseEvent) => {
    e.preventDefault();
    if (templateMode.startsWith('user_')) {
      const updated = savedTemplates.map(t => 
        t.id === templateMode ? { ...t, content: customInstruction } : t
      );
      setSavedTemplates(updated);
      localStorage.setItem('gemini_custom_templates', JSON.stringify(updated));
    } else {
      setIsSavingNew(true);
    }
  };

  const confirmSaveTemplate = (e?: React.MouseEvent | React.KeyboardEvent) => {
    if (e) e.preventDefault();
    if (!newTemplateName.trim()) return;
    const newId = 'user_' + Date.now();
    const newTemplates = [...savedTemplates, { id: newId, name: newTemplateName.trim(), content: customInstruction }];
    setSavedTemplates(newTemplates);
    localStorage.setItem('gemini_custom_templates', JSON.stringify(newTemplates));
    setTemplateMode(newId);
    setIsSavingNew(false);
    setNewTemplateName('');
  };

  const handleDeleteTemplate = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!templateMode.startsWith('user_')) return;
    if (!window.confirm('Are you sure you want to delete this template?')) return;
    const updated = savedTemplates.filter(t => t.id !== templateMode);
    setSavedTemplates(updated);
    localStorage.setItem('gemini_custom_templates', JSON.stringify(updated));
    handleTemplateChange('default');
  };

  const handleExportTemplates = () => {
    if (savedTemplates.length === 0) {
      alert('No custom templates to export.');
      return;
    }
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(savedTemplates, null, 2));
    const downloadAnchorNode = document.createElement('a');
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
          const existingIds = new Set(savedTemplates.map(t => t.id));
          const newTemplates = [...savedTemplates];
          let added = 0;
          for (const t of imported) {
            if (t.id && t.name && t.content && !existingIds.has(t.id)) {
              newTemplates.push(t);
              added++;
            }
          }
          setSavedTemplates(newTemplates);
          localStorage.setItem('gemini_custom_templates', JSON.stringify(newTemplates));
          alert(`Successfully imported ${added} templates.`);
        } else {
          alert('Invalid templates file format.');
        }
      } catch (err) {
        alert('Failed to parse templates file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleTestOllama = async () => {
    setTestingOllama(true);
    const isConnected = await checkOllamaConnection(ollamaUrl);
    setOllamaConnected(isConnected);
    if (isConnected) {
      const models = await fetchOllamaModels(ollamaUrl);
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
      const models = await fetchOpenAICompatibleModels(customBaseUrl, customApiKey);
      setAvailableCustomModels(models);
      setCustomProviderConnected(true);
      // Removed auto-select of models[0] so the input remains empty and the user can see the full unfiltered datalist.
      if (models.length > 0 && customModel && !models.includes(customModel)) {
        setCustomModel('');
      }
    } catch (e: any) {
      console.error(e);
      setCustomProviderConnected(false);
      let msg = e.message || "Unknown error";
      if (msg === "Failed to fetch") {
        msg = "Network or CORS error. The API might block browser requests to /models. You can still type the model name manually (e.g., grok-4-latest) and try generating.";
      }
      setCustomProviderError(msg);
      setAvailableCustomModels([]);
    }
    setTestingCustomProvider(false);
  };

  const handleQwenLogin = async () => {
    try {
      setQwenAuthStatus('polling');
      setQwenAuthMessage('Starting authorization...');
      
      const authData = await startDeviceAuth();
      setQwenAuthUrl(authData.verification_uri_complete);
      setQwenAuthMessage('Please open the URL in your browser to authorize.');
      
      // Open the URL in a new tab
      window.open(authData.verification_uri_complete, '_blank');

      let pollInterval = 2000;
      const maxAttempts = Math.ceil(authData.expires_in / (pollInterval / 1000));
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const tokenResponse = await pollDeviceToken(authData.device_code, authData.codeVerifier);
        
        if (tokenResponse.status === 'success') {
          // Store the access token
          setQwenOAuthToken(tokenResponse.data.access_token);
          if (tokenResponse.data.resource_url) {
            setQwenResourceUrl(tokenResponse.data.resource_url);
          }
          setQwenAuthStatus('success');
          setQwenAuthMessage('Authentication successful!');
          setQwenAuthUrl(null);
          return;
        }
        
        if (tokenResponse.status === 'pending') {
          if (tokenResponse.slowDown) {
            pollInterval = Math.min(pollInterval * 1.5, 10000);
          } else {
            pollInterval = 2000;
          }
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          continue;
        }
      }
      
      setQwenAuthStatus('error');
      setQwenAuthMessage('Authorization timed out. Please try again.');
      setQwenAuthUrl(null);
    } catch (error: any) {
      setQwenAuthStatus('error');
      setQwenAuthMessage(error.message || 'Failed to authenticate with Qwen.');
      setQwenAuthUrl(null);
    }
  };

  const handleDownloadBat = () => {
    const origin = window.location.origin;
    const batContent = `@echo off
color 0A
echo ==========================================
echo Starting Ollama with CORS enabled...
echo You can now use the Gemini Prompt Generator!
echo ==========================================
set OLLAMA_ORIGINS="${origin}"
echo Closing existing Ollama instances...
taskkill /f /im ollama.exe >nul 2>&1
echo Starting Ollama with CORS enabled for ${origin}...
start "" ollama serve
pause`;
    const blob = new Blob([batContent], { type: 'application/bat' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'start-ollama.bat';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAttachDocs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const files = Array.from(e.target.files) as File[];
    const newDocs: {name: string, content: string}[] = [];
    for (const file of files) {
      try {
        const content = await file.text();
        newDocs.push({ name: file.name, content });
      } catch (err) {
        console.error(`Failed to read file ${file.name}`, err);
      }
    }
    setAttachedDocs(prev => [...prev, ...newDocs]);
    e.target.value = '';
  };

  const removeAttachedDoc = (index: number) => {
    setAttachedDocs(prev => prev.filter((_, i) => i !== index));
  };

  const getSystemPrompt = (mode: string, customText?: string): string => {
    const template = getTemplate(mode);
    
    if (!template) {
      // Fallback to original behavior for custom or saved templates
      return customText || '';
    }

    // Build enhanced prompt with deliverables and metrics
    const promptParts = [
      template.systemInstruction,
    ];

    if (template.deliverables && template.deliverables.length > 0) {
      promptParts.push('', '## 📦 Required Deliverables', ...template.deliverables.map(d => `- ${d}`));
    }

    if (template.successMetrics && template.successMetrics.length > 0) {
      promptParts.push('', '## ✅ Success Criteria', ...template.successMetrics.map(m => `- ${m}`));
    }

    if (template.evidenceRequirements && template.evidenceRequirements.length > 0) {
      promptParts.push('', '## 🔍 Evidence Requirements', ...template.evidenceRequirements.map(e => `- ${e}`));
    }

    if (template.tone) {
      promptParts.push('', '## 🎭 Tone', template.tone);
    }

    if (template.constraints && template.constraints.length > 0) {
      promptParts.push('', '## ⚠️ Constraints', ...template.constraints.map(c => `- ${c}`));
    }

    return promptParts.join('\n');
  };

  const cancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
    setStatus('Generation cancelled by user.');
  };

  const delay = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      const timeout = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      });
    });
  };

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (inputMode === 'github' && !url) return;
    if (inputMode === 'local' && (!localFiles || localFiles.length === 0)) return;
    
    if (useRag && !ragModel) {
      setError('Please select an Embedding Model for RAG. It is required to process the repository files.');
      return;
    }
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setLoading(true);
    setError(null);
    setPrompt(null);
    setUsedModel(null);
    setLastOptimizedQuery(null);
    setCopied(false);
    setIsTruncated(false);

    try {
      let repoData;

      if (inputMode === 'github') {
        const currentCacheKey = `${url}-${githubToken}-${maxFiles}`;
        
        if (cachedRepoData && cacheKey === currentCacheKey) {
          setStatus('Using cached repository data...');
          repoData = cachedRepoData;
        } else {
          setStatus('Fetching repository data...');
          repoData = await fetchRepoData(url, githubToken, maxFiles);
          setCachedRepoData(repoData);
          setCacheKey(currentCacheKey);
        }
      } else {
        setStatus('Processing local files...');
        repoData = await processLocalFolder(localFiles!, maxFiles);
        // Do not cache local files in state to save memory, they are fast to read anyway
        setCachedRepoData(null);
        setCacheKey('');
        
        // Free up memory by clearing the file selection if it's very large
        if (localFiles && localFiles.length > 1000) {
          setLocalFiles(null);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
      }
      
      if (repoData.isTruncated) {
        setIsTruncated(true);
      }

      // Generate file name base
      let projectName = 'project';
      if (repoData.info && repoData.info.repo) {
        projectName = repoData.info.repo;
      }
      const templateName = templateMode === 'default' ? 'gemini' : templateMode;
      const date = new Date();
      const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;

      let referenceRepoData;
      const isCustomMode = templateMode === 'custom' || templateMode.startsWith('user_');
      const shouldFetchReference = templateMode === 'integration' || (isCustomMode && useReferenceRepo);

      if (shouldFetchReference) {
        if (referenceInputMode === 'github' && referenceUrl) {
          const currentRefCacheKey = `${referenceUrl}-${githubToken}-${referenceMaxFiles}`;
          if (cachedReferenceRepoData && referenceCacheKey === currentRefCacheKey) {
            setStatus('Using cached reference repository data...');
            referenceRepoData = cachedReferenceRepoData;
          } else {
            setStatus('Fetching reference repository data...');
            referenceRepoData = await fetchRepoData(referenceUrl, githubToken, referenceMaxFiles);
            setCachedReferenceRepoData(referenceRepoData);
            setReferenceCacheKey(currentRefCacheKey);
          }
        } else if (referenceInputMode === 'local' && referenceLocalFiles && referenceLocalFiles.length > 0) {
          setStatus('Processing local reference files...');
          referenceRepoData = await processLocalFolder(referenceLocalFiles, referenceMaxFiles);
          setCachedReferenceRepoData(null);
          setReferenceCacheKey('');
        }
        
        if (referenceRepoData && referenceRepoData.isTruncated) {
          setIsTruncated(true);
        }
      }
      
      let currentQwenRateLimit: any = null;
      let finalUsedRagQuery = '';
      let finalUsedOptimizedQuery = '';

      if (useRag && repoData.sourceFiles && repoData.sourceFiles.length > 0) {
        try {
          const getFallbackQuery = () => {
            const template = getTemplate(templateMode);
            let query = template ? template.defaultSearchQuery : customInstruction.substring(0, 500);
            
            // Append user context to specialize the RAG query
            if (additionalContext.trim()) {
              query += `\n\nSpecific Task Context: ${additionalContext.substring(0, 500)}`;
            }
            if (attachedDocs.length > 0) {
              const docNames = attachedDocs.map(d => d.name).join(', ');
              query += `\n\nAttached Documents: ${docNames}`;
            }
            return query;
          };
          
          let baseQuery = ragQuery.trim() !== '' ? ragQuery : getFallbackQuery();
          let optimizedQuery = baseQuery;
          let queryIntent = 'GENERAL';
          
          // Optimization: Skip LLM call if using a standard template's default query AND no extra context is provided
          const hasExtraContext = additionalContext.trim() !== '' || attachedDocs.length > 0;
          const isStandardTemplateDefault = ragQuery.trim() === '' && getTemplate(templateMode) !== undefined && !hasExtraContext;
          
          if ((useQueryExpansion || useIntentReranking) && !isStandardTemplateDefault) {
            setStatus('Optimizing RAG query with LLM...');
            try {
              // Simple caching to avoid repeated LLM calls for the same custom template
              // We include more context in the key to prevent stale results when instructions change
              const queryHash = baseQuery.length + "_" + baseQuery.substring(0, 30) + "_" + baseQuery.substring(baseQuery.length - 30);
              const contextHash = additionalContext.length + "_" + additionalContext.substring(0, 20);
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
                setLastOptimizedQuery({ query: optimizedQuery, intent: queryIntent });
              } else {
                let result;
                if (useOllamaForFinal) {
                  result = await rewriteQueryWithOllama(baseQuery, ollamaUrl, ollamaModel);
                } else {
                  result = await rewriteQuery(aiProvider, baseQuery, { 
                    qwenToken: qwenOAuthToken, 
                    qwenResourceUrl: qwenResourceUrl || undefined,
                    customBaseUrl,
                    customApiKey,
                    customModel
                  });
                  if (aiProvider === 'qwen' && result.rateLimit) {
                    setQwenRateLimit(result.rateLimit);
                    currentQwenRateLimit = result.rateLimit;
                  }
                }
                
                if (useQueryExpansion) {
                  optimizedQuery = result.optimizedQuery;
                  setStatus(`RAG query optimized: ${optimizedQuery}`);
                }
                if (useIntentReranking) {
                  queryIntent = result.intent;
                }
                
                // Save to cache
                localStorage.setItem(cacheKey, JSON.stringify({ optimizedQuery: result.optimizedQuery, intent: result.intent }));
                setLastOptimizedQuery({ query: optimizedQuery, intent: queryIntent });
              }
              
              console.log("Original RAG query:", baseQuery);
              console.log("Optimized RAG query:", optimizedQuery);
              console.log("Detected Intent:", queryIntent);
            } catch (e) {
              console.warn("Query optimization failed, using original query", e);
              setLastOptimizedQuery(null);
            }
          } else {
            if (isStandardTemplateDefault) {
              console.log("Skipping LLM expansion: using standard template default RAG query.");
              // Map intent based on template if possible
              if (templateMode === 'audit' || templateMode === 'security') queryIntent = 'BUGFIX';
              else if (templateMode === 'architecture' || templateMode === 'integration') queryIntent = 'ARCHITECTURE';
              else if (templateMode === 'docs' || templateMode === 'eli5') queryIntent = 'GENERAL';
            }
            setLastOptimizedQuery({ query: optimizedQuery, intent: queryIntent });
          }

          const finalRagQuery = optimizedQuery.substring(0, 1000);
          finalUsedRagQuery = ragQuery;
          finalUsedOptimizedQuery = finalRagQuery;

          // Update the UI state so the user can see what was actually used for the search
          if (!lastOptimizedQuery || lastOptimizedQuery.query.trim() === '') {
            setLastOptimizedQuery({ query: finalRagQuery, intent: queryIntent || 'AUTO_FALLBACK' });
          }

          setStatus('Running RAG: Filtering codebase...');
          const ragFiles = await performRAG(
            repoData.sourceFiles,
            finalRagQuery,
            queryIntent,
            ollamaUrl,
            ragModel,
            url, // Target repo URL
            ragTopK,
            ragSearchStrategy,
            (msg) => setStatus(msg)
          );
          repoData = { ...repoData, sourceFiles: ragFiles };
          
          if (referenceRepoData && referenceRepoData.sourceFiles && referenceRepoData.sourceFiles.length > 0) {
            setStatus('Running RAG: Filtering reference codebase...');
            const refRagFiles = await performRAG(
              referenceRepoData.sourceFiles,
              finalRagQuery,
              queryIntent,
              ollamaUrl,
              ragModel,
              referenceUrl, // Reference repo URL
              ragTopK,
              ragSearchStrategy,
              (msg) => setStatus(msg)
            );
            referenceRepoData = { ...referenceRepoData, sourceFiles: refRagFiles };
          }
        } catch (e: any) {
          setError(`RAG failed: ${e.message}`);
          setLoading(false);
          return;
        }
      }
      
      let usedOllama = false;
      if (useOllama && ollamaConnected !== false) {
        setStatus('Summarizing with local Ollama...');
        usedOllama = true;
        
        const summarize = async (text: string) => {
           return text ? await summarize_with_ollama(text, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaSummaryPredict, ollamaTemperature) : '';
        };

        const summarizedSourceFiles = [];
        if (repoData.sourceFiles) {
          for (const file of repoData.sourceFiles) {
            setStatus(`Summarizing ${file.path} with Ollama...`);
            const summary = await summarize(file.content);
            summarizedSourceFiles.push({ path: file.path, content: summary });
          }
        }

        repoData = {
          ...repoData,
          readme: await summarize(repoData.readme),
          dependencies: await summarize(repoData.dependencies),
          sourceFiles: summarizedSourceFiles
        };

        if (referenceRepoData) {
          const refSummarizedSourceFiles = [];
          if (referenceRepoData.sourceFiles) {
            for (const file of referenceRepoData.sourceFiles) {
              setStatus(`Summarizing reference ${file.path} with Ollama...`);
              const summary = await summarize(file.content);
              refSummarizedSourceFiles.push({ path: file.path, content: summary });
            }
          }
          referenceRepoData = {
            ...referenceRepoData,
            readme: await summarize(referenceRepoData.readme),
            dependencies: await summarize(referenceRepoData.dependencies),
            sourceFiles: refSummarizedSourceFiles
          };
        }
      }
      
      let generatedPrompt = '';
      let finalModel = '';
      const taskInstruction = getSystemPrompt(templateMode, customInstruction);
      
      if (useOllamaForFinal && ollamaConnected !== false) {
        setStatus('Generating final prompt with local Ollama...');
        const promptText = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs, fileTruncationLimit);
        
        const inputTokens = Math.ceil(promptText.length / 4);
        const availableTokens = ollamaNumCtx - inputTokens;
        
        if (availableTokens < ollamaFinalPredict) {
          const proceed = await new Promise<boolean>((resolve) => {
            setTokenWarning({
              inputTokens,
              availableTokens,
              requestedTokens: ollamaFinalPredict,
              promptText
            });
            setTokenWarningResolver(() => resolve);
          });
          
          setTokenWarning(null);
          setTokenWarningResolver(null);
          
          if (!proceed) {
            setLoading(false);
            setStatus('');
            return;
          }
        }
        
        generatedPrompt = await generate_final_prompt_with_ollama(promptText, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaFinalPredict, ollamaTemperature);
        
        finalModel = `Ollama (${ollamaModel})`;
      } else {
        if (aiProvider === 'qwen' && currentQwenRateLimit) {
          const remainingReqs = parseInt(currentQwenRateLimit.remainingRequests || '1', 10);
          const remainingTokens = parseInt(currentQwenRateLimit.remainingTokens || '100000', 10);
          
          if (remainingReqs <= 0 || remainingTokens < 10000) {
            const resetReqs = parseInt(currentQwenRateLimit.resetRequests || '0', 10);
            const resetTokens = parseInt(currentQwenRateLimit.resetTokens || '0', 10);
            const waitTime = Math.max(resetReqs, resetTokens) + 2000; // 2 seconds buffer
            
            if (waitTime > 0) {
              setStatus(`Qwen rate limit reached. Pausing for ${Math.ceil(waitTime / 1000)} seconds to reset quota...`);
              await delay(waitTime, signal);
            }
          }
        }

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
            qwenToken: qwenOAuthToken, 
            qwenResourceUrl: qwenResourceUrl || undefined,
            customBaseUrl,
            customApiKey,
            customModel,
            fileTruncationLimit
          }
        );
        generatedPrompt = result.text;
        finalModel = result.modelVersion;
        if (aiProvider === 'qwen' && result.rateLimit) {
          setQwenRateLimit(result.rateLimit);
        }
      }
      
      let metadata = `> **🤖 Prompt Generation Metadata**\n`;
      metadata += `> - **Model:** ${finalModel}\n`;
      metadata += `> - **Target Repository:** ${url || 'Local Folder'}\n`;
      if (referenceRepoData) {
        if (referenceInputMode === 'local') {
          metadata += `> - **Reference Repository:** Local Folder\n`;
        } else if (referenceUrl) {
          metadata += `> - **Reference Repository:** ${referenceUrl}\n`;
        }
      }
      
      if (useRag) {
        if (finalUsedRagQuery) {
          metadata += `> - **Original RAG Query:** "${finalUsedRagQuery}"\n`;
          if (finalUsedOptimizedQuery && finalUsedOptimizedQuery !== finalUsedRagQuery) {
            metadata += `> - **Optimized RAG Query:** "${finalUsedOptimizedQuery}"\n`;
          }
        } else {
          metadata += `> - **Auto-generated RAG Query:** "${finalUsedOptimizedQuery || 'Unknown'}"\n`;
        }
      }
      if (usedOllama) metadata += `> - **Pre-processing:** Local LLM (Ollama)\n`;
      
      metadata += `> \n`;
      metadata += `> <details><summary><b>Task Instructions</b></summary>\n> \n`;
      metadata += `> \`\`\`text\n`;
      metadata += taskInstruction.split('\n').map(line => `> ${line}`).join('\n') + '\n';
      metadata += `> \`\`\`\n`;
      metadata += `> </details>\n`;

      if (additionalContext) {
        metadata += `>\n> <details><summary><b>Additional Context</b></summary>\n> \n`;
        metadata += `> \`\`\`text\n`;
        metadata += additionalContext.split('\n').map(line => `> ${line}`).join('\n') + '\n';
        metadata += `> \`\`\`\n`;
        metadata += `> </details>\n`;
      }

      metadata += `\n---\n\n`;

      generatedPrompt = metadata + generatedPrompt;

      const safeModelName = finalModel.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase();
      setGeneratedFileName(`${projectName}_${templateName}_${safeModelName}_${timestamp}.md`);
      
      setPrompt(generatedPrompt);
      setUsedModel(finalModel);
    } catch (err: any) {
      if (aiProvider === 'qwen' && (err.status === 401 || err.status === 403)) {
        setQwenOAuthToken('');
        setError('Qwen session expired. Please re-authenticate.');
      } else if (aiProvider === 'qwen' && err.status === 429) {
        setError('Qwen rate limit exceeded. Please wait a moment and try again.');
      } else {
        setError(err.message || 'An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
      setStatus('');
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
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900 pb-24">
      <div className="max-w-4xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-100 rounded-2xl mb-4">
            <FileText className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl mb-4">
            Gemini Prompt Generator
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            Generate a comprehensive system prompt for your GitHub repository, ready to be used with Gemini CLI or Antigravity.
          </p>
        </div>

        {/* Input Form */}
        <div className="bg-white shadow-sm ring-1 ring-slate-200 rounded-2xl p-6 sm:p-8 mb-8">
          <div className="flex border-b border-slate-200 mb-6">
            <button
              type="button"
              className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${inputMode === 'github' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
              onClick={() => setInputMode('github')}
            >
              <Github className="w-4 h-4 inline-block mr-2" />
              GitHub Repository
            </button>
            <button
              type="button"
              className={`py-2 px-4 text-sm font-medium border-b-2 transition-colors ${inputMode === 'local' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
              onClick={() => setInputMode('local')}
            >
              <Folder className="w-4 h-4 inline-block mr-2" />
              Local Folder
            </button>
          </div>

          <form onSubmit={handleGenerate} className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4">
              {inputMode === 'github' ? (
                <div className="relative flex-grow">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Github className="h-5 w-5 text-slate-400" />
                  </div>
                  <input
                    type="url"
                    required
                    placeholder="https://github.com/owner/repo"
                    className="block w-full pl-10 pr-3 py-3 border border-slate-300 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={loading}
                  />
                </div>
              ) : (
                <div className="flex-grow">
                  <input
                    type="file"
                    ref={fileInputRef}
                    // @ts-ignore - webkitdirectory is non-standard but widely supported
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={(e) => {
                      e.preventDefault(); // Prevent any default behavior
                      setLocalFiles(e.target.files);
                    }}
                    className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer"
                    disabled={loading}
                  />
                  {localFiles && localFiles.length > 0 && (
                    <p className="mt-2 text-sm text-slate-600">
                      Selected {localFiles.length} files from {localFiles[0].webkitRelativePath.split('/')[0]}
                    </p>
                  )}
                </div>
              )}
              
              {aiProvider === 'qwen' && qwenRateLimit && qwenRateLimit.remainingRequests && (
                <div className="flex items-center justify-center gap-4 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5" title="Qwen Requests Quota">
                    <div className={`w-2 h-2 rounded-full ${parseInt(qwenRateLimit.remainingRequests) > 10 ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
                    <span>Reqs: {qwenRateLimit.remainingRequests}</span>
                  </div>
                  {qwenRateLimit.remainingTokens && (
                    <div className="flex items-center gap-1.5" title="Qwen Tokens Quota">
                      <div className={`w-2 h-2 rounded-full ${parseInt(qwenRateLimit.remainingTokens) > 50000 ? 'bg-emerald-500' : 'bg-amber-500'}`}></div>
                      <span>Tokens: {qwenRateLimit.remainingTokens}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {inputMode === 'github' && (
                <div>
                  <label htmlFor="githubToken" className="block text-xs font-medium text-slate-500 mb-1">
                    GitHub Token (Optional)
                  </label>
                  <input
                    type="password"
                    id="githubToken"
                    className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                    placeholder="ghp_..."
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    disabled={loading}
                  />
                </div>
              )}
              <div className={inputMode === 'local' ? 'col-span-1 sm:col-span-2' : ''}>
                <label htmlFor="maxFiles" className="block text-xs font-medium text-slate-500 mb-1">
                  Max Source Files to Fetch
                </label>
                <input
                  type="number"
                  id="maxFiles"
                  className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                  value={maxFiles}
                  onChange={(e) => setMaxFiles(Number(e.target.value))}
                  disabled={loading}
                  min={1}
                  max={inputMode === 'local' ? 200 : (githubToken ? 200 : 10)}
                />
                <p className="mt-1 text-xs text-slate-500">
                  {inputMode === 'local' 
                    ? 'Limit: 200 files (Local processing is fast).' 
                    : (githubToken ? 'Limit: 200 files (Token provided).' : 'Limit: 10 files (Add token to increase up to 200).')}
                </p>
              </div>
            </div>

            {(templateMode === 'integration' || ((templateMode === 'custom' || templateMode.startsWith('user_')) && useReferenceRepo)) && (
              <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center">
                  <Database className="w-4 h-4 mr-2 text-indigo-500" />
                  Reference Repository (Source of Truth)
                </h3>
                <div className="flex border-b border-slate-200 mb-4">
                  <button
                    type="button"
                    className={`py-1.5 px-3 text-xs font-medium border-b-2 transition-colors ${referenceInputMode === 'github' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
                    onClick={() => setReferenceInputMode('github')}
                  >
                    <Github className="w-3 h-3 inline-block mr-1.5" />
                    GitHub
                  </button>
                  <button
                    type="button"
                    className={`py-1.5 px-3 text-xs font-medium border-b-2 transition-colors ${referenceInputMode === 'local' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}
                    onClick={() => setReferenceInputMode('local')}
                  >
                    <Folder className="w-3 h-3 inline-block mr-1.5" />
                    Local
                  </button>
                </div>
                
                <div className="flex flex-col sm:flex-row gap-4">
                  {referenceInputMode === 'github' ? (
                    <div className="relative flex-grow">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Github className="h-4 w-4 text-slate-400" />
                      </div>
                      <input
                        type="url"
                        placeholder="https://github.com/owner/reference-repo"
                        className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow"
                        value={referenceUrl}
                        onChange={(e) => setReferenceUrl(e.target.value)}
                        disabled={loading}
                      />
                    </div>
                  ) : (
                    <div className="flex-grow">
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
                        className="block w-full text-sm text-slate-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 cursor-pointer"
                        disabled={loading}
                      />
                      {referenceLocalFiles && referenceLocalFiles.length > 0 && (
                        <p className="mt-1 text-xs text-slate-600">
                          Selected {referenceLocalFiles.length} files
                        </p>
                      )}
                    </div>
                  )}
                  <div className="w-full sm:w-40">
                    <input
                      type="number"
                      placeholder="Max Files"
                      className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                      value={referenceMaxFiles}
                      onChange={(e) => setReferenceMaxFiles(Number(e.target.value))}
                      min={1}
                      max={referenceInputMode === 'local' ? 200 : (githubToken ? 200 : 10)}
                      disabled={loading}
                      title={referenceInputMode === 'local' ? 'Limit: 200 files' : (githubToken ? 'Limit: 200 files' : 'Limit: 10 files (Add token to increase)')}
                    />
                    <p className="mt-1 text-[10px] text-slate-500 leading-tight">
                      {referenceInputMode === 'local' 
                        ? 'Max: 200 (Local)' 
                        : (githubToken ? 'Max: 200 (Token)' : 'Max: 10 (No Token)')}
                    </p>
                  </div>
                </div>
              </div>
            )}
            
            <div className="mt-4 p-4 bg-indigo-50/50 rounded-xl border border-indigo-100">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center">
                  <Settings2 className="w-4 h-4 text-indigo-600 mr-2" />
                  <label htmlFor="templateMode" className="block text-sm font-medium text-slate-700">
                    Task Template
                  </label>
                </div>
                <div className="flex gap-3">
                  <button type="button" onClick={handleExportTemplates} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                    Export
                  </button>
                  <label className="text-xs text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer">
                    Import
                    <input type="file" accept=".json" className="hidden" onChange={handleImportTemplates} />
                  </label>
                </div>
              </div>
              <div className="mb-4">
                <select
                  id="templateMode"
                  value={templateMode}
                  onChange={(e) => handleTemplateChange(e.target.value)}
                  className="block w-full px-3 py-3 border border-slate-300 rounded-xl leading-5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow"
                  disabled={loading}
                >
                  <optgroup label="Built-in Templates">
                    {getAllTemplates().map((template) => (
                      <option key={template.metadata.id} value={template.metadata.id}>
                        {template.metadata.name} - {template.metadata.description}
                      </option>
                    ))}
                  </optgroup>
                  {savedTemplates.length > 0 && (
                    <optgroup label="Saved Templates">
                      {savedTemplates.map(t => (
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
              </div>

              {getTemplate(templateMode) ? (
                <div className="relative">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Template Content (Read-only)</label>
                  <pre className="block w-full px-3 py-3 border border-slate-200 rounded-xl leading-5 bg-slate-50 text-slate-600 sm:text-sm whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-xs">
                    {getSystemPrompt(templateMode, customInstruction)}
                  </pre>
                </div>
              ) : (
                <div className="relative">
                  <textarea
                    rows={6}
                    placeholder="Enter your custom system instruction here. The repository context (Tree, README, Dependencies) will be automatically appended to your prompt."
                    className="block w-full px-3 py-3 border border-slate-300 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow resize-y"
                    value={customInstruction}
                    onChange={(e) => {
                      setCustomInstruction(e.target.value);
                      if (!templateMode.startsWith('user_') && templateMode !== 'custom') {
                        setTemplateMode('custom');
                      }
                    }}
                    disabled={loading}
                  />
                  <div className="flex justify-between items-center mt-3">
                    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer hover:text-indigo-600 transition-colors">
                      <input
                        type="checkbox"
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-4 h-4 cursor-pointer"
                        checked={useReferenceRepo}
                        onChange={(e) => setUseReferenceRepo(e.target.checked)}
                        disabled={loading}
                      />
                      <Database className="w-4 h-4" />
                      <span>Add Reference Repository (for comparison, porting, etc.)</span>
                    </label>
                    <div className="flex justify-end gap-2">
                      {templateMode.startsWith('user_') && (
                      <button
                        type="button"
                        onClick={handleDeleteTemplate}
                        disabled={loading}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4 mr-1.5" />
                        Delete
                      </button>
                    )}
                    {templateMode.startsWith('user_') && customInstruction.trim() !== '' && (
                      <button
                        type="button"
                        onClick={handleSaveTemplate}
                        disabled={loading}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Save className="w-4 h-4 mr-1.5" />
                        Save Changes
                      </button>
                    )}
                    {!templateMode.startsWith('user_') && customInstruction.trim() !== '' && (
                      isSavingNew ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newTemplateName}
                            onChange={(e) => setNewTemplateName(e.target.value)}
                            placeholder="Template name..."
                            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                confirmSaveTemplate(e);
                              } else if (e.key === 'Escape') {
                                setIsSavingNew(false);
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={confirmSaveTemplate}
                            disabled={!newTemplateName.trim() || loading}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsSavingNew(false)}
                            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setIsSavingNew(true)}
                          disabled={loading}
                          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <Save className="w-4 h-4 mr-1.5" />
                          Save as Template
                        </button>
                      )
                    )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-2">
              <label htmlFor="additionalContext" className="block text-sm font-medium text-slate-700 mb-2">
                Task Instructions & External Context
              </label>
              <textarea
                id="additionalContext"
                rows={3}
                placeholder={templateMode === 'integration' ? "What do you want to integrate? (Leave empty to let AI discover the best architectural patterns to borrow from the Reference Repo)" : "e.g., I'm planning to add GPU acceleration support for Nvidia RTX 4xxx series..."}
                className="block w-full px-3 py-3 border border-slate-300 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow resize-y mb-2"
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                disabled={loading}
              />
              
              {attachedDocs.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {attachedDocs.map((doc, i) => (
                    <div key={i} className="flex items-center gap-1 bg-indigo-50 text-indigo-700 px-2 py-1 rounded-md text-sm border border-indigo-100">
                      <Paperclip className="w-3 h-3" />
                      <span className="truncate max-w-[150px]">{doc.name}</span>
                      <button type="button" onClick={() => removeAttachedDoc(i)} className="hover:text-indigo-900 ml-1">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  {templateMode === 'integration' ? 'Describe what exactly you want to integrate or migrate from the Reference Repo.' : 'Provide any specific goals, future directions, or constraints you want the AI to know about.'}
                </p>
                <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors border border-slate-200">
                  <Paperclip className="w-3 h-3" />
                  Attach Documents (.md, .txt)
                  <input 
                    type="file" 
                    multiple 
                    accept=".md,.txt,.json,.csv,.log" 
                    className="hidden" 
                    onChange={handleAttachDocs}
                    disabled={loading}
                  />
                </label>
              </div>
            </div>

            <div className="mt-2 flex items-center">
              <input
                id="analyzeIssues"
                type="checkbox"
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                checked={analyzeIssues}
                onChange={(e) => setAnalyzeIssues(e.target.checked)}
                disabled={loading}
              />
              <label htmlFor="analyzeIssues" className="ml-2 block text-sm text-slate-700 cursor-pointer">
                Analyze repository for obvious errors, bugs, and outdated dependencies
              </label>
            </div>

            {/* AI Provider Settings */}
            <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                AI Provider
              </label>
              <select
                value={aiProvider}
                onChange={(e) => setAiProvider(e.target.value as AIProvider)}
                className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2"
                disabled={loading}
              >
                <option value="gemini">✨ Gemini (default)</option>
                <option value="qwen">🔥 Qwen (via OAuth)</option>
                <option value="ollama">🏠 Ollama (local, private)</option>
                <option value="custom">🌐 Custom (OpenAI Compatible)</option>
              </select>
              
              {aiProvider === 'custom' && (
                <div className="mt-4 p-4 bg-white border border-slate-200 rounded-lg shadow-sm space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-slate-700">
                      Custom Provider Settings
                    </label>
                    <select
                      className="text-xs border border-slate-300 rounded px-2 py-1 bg-slate-50"
                      onChange={(e) => {
                        if (e.target.value) {
                          setCustomBaseUrl(e.target.value);
                          setCustomProviderConnected(null);
                        }
                      }}
                      defaultValue=""
                    >
                      <option value="" disabled>Load Preset...</option>
                      <option value="https://openrouter.ai/api/v1">OpenRouter</option>
                      <option value="https://integrate.api.nvidia.com/v1">NVIDIA NIM</option>
                      <option value="https://api.groq.com/openai/v1">Groq</option>
                      <option value="https://api.x.ai/v1">xAI (Grok)</option>
                      <option value="https://models.inference.ai.azure.com">GitHub Models</option>
                      <option value="https://api.mistral.ai/v1">Mistral</option>
                      <option value="https://api.cerebras.ai/v1">Cerebras</option>
                      <option value="https://api.moonshot.cn/v1">Kimi (Moonshot)</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Base URL (OpenAI Compatible)</label>
                    <input
                      type="text"
                      value={customBaseUrl}
                      onChange={(e) => { setCustomBaseUrl(e.target.value); setCustomProviderConnected(null); }}
                      placeholder="e.g., https://api.groq.com/openai/v1"
                      className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                      disabled={loading}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">API Key</label>
                    <input
                      type="password"
                      value={customApiKey}
                      onChange={(e) => { setCustomApiKey(e.target.value); setCustomProviderConnected(null); }}
                      placeholder="sk-..."
                      className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                      disabled={loading}
                    />
                  </div>
                  
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-500 mb-1">Model Name</label>
                      <input
                        type="text"
                        list="custom-models-list"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="e.g., llama3-8b-8192"
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                        disabled={loading}
                      />
                      {availableCustomModels.length > 0 && (
                        <datalist id="custom-models-list">
                          {availableCustomModels
                            .filter(m => m.toLowerCase().includes(customModel.toLowerCase()))
                            .slice(0, 300)
                            .map(m => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={handleTestCustomProvider}
                      disabled={testingCustomProvider || loading}
                      className="text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50 h-[38px]"
                    >
                      {testingCustomProvider ? 'Fetching...' : 'Fetch Models'}
                    </button>
                  </div>
                  
                  {customProviderConnected === true && (
                    <p className="text-xs text-emerald-600 flex items-center mt-2">
                      <Check className="w-3 h-3 mr-1" /> Successfully connected to provider
                    </p>
                  )}
                  {customProviderConnected === false && (
                    <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-600 flex items-start mt-2">
                      <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                      <div>
                        <strong>Connection failed:</strong> {customProviderError || "Check URL and API Key."}
                      </div>
                    </div>
                  )}
                  
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start mt-2">
                    <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                    <p>
                      <strong>Warning:</strong> Free API providers often have strict context limits (e.g., 8k or 32k tokens). 
                      It is highly recommended to keep <strong>RAG enabled</strong> with a small Top-K to avoid "Context length exceeded" errors.
                    </p>
                  </div>
                </div>
              )}
              
              {aiProvider === 'qwen' && (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-500 mb-2">
                    Qwen Account Authentication
                  </label>
                  
                  {qwenOAuthToken ? (
                    <div>
                      <div className="flex items-center justify-between p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                        <div className="flex items-center text-emerald-700 text-sm font-medium">
                          <Check className="w-4 h-4 mr-2" />
                          Authenticated with Qwen
                        </div>
                        <button
                          onClick={() => {
                            setQwenOAuthToken('');
                            setQwenAuthStatus('idle');
                            setQwenAuthMessage('');
                            setQwenRateLimit(null);
                          }}
                          className="text-xs text-slate-500 hover:text-slate-700 underline"
                        >
                          Sign Out
                        </button>
                      </div>
                      {qwenRateLimit && (
                        <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                          {qwenRateLimit.remainingRequests ? (
                            <>
                              <div className="flex justify-between items-center mb-1">
                                <span className="font-medium text-slate-700">Qwen Quota (Reqs)</span>
                                <span className="text-slate-500">{qwenRateLimit.remainingRequests} remaining</span>
                              </div>
                              <div className="w-full bg-slate-200 rounded-full h-1.5 mb-2">
                                <div 
                                  className={`h-1.5 rounded-full ${parseInt(qwenRateLimit.remainingRequests) > 10 ? 'bg-emerald-500' : parseInt(qwenRateLimit.remainingRequests) > 2 ? 'bg-amber-500' : 'bg-red-500'}`} 
                                  style={{ width: `${Math.min(100, Math.max(0, (parseInt(qwenRateLimit.remainingRequests) / 30) * 100))}%` }}
                                ></div>
                              </div>
                            </>
                          ) : (
                            <div className="text-slate-500 italic mb-2">Rate limit headers not provided by Qwen API</div>
                          )}
                          
                          {qwenRateLimit.remainingTokens && (
                            <>
                              <div className="flex justify-between items-center mb-1">
                                <span className="font-medium text-slate-700">Qwen Quota (Tokens)</span>
                                <span className="text-slate-500">{qwenRateLimit.remainingTokens} remaining</span>
                              </div>
                              <div className="w-full bg-slate-200 rounded-full h-1.5 mb-1">
                                <div 
                                  className={`h-1.5 rounded-full ${parseInt(qwenRateLimit.remainingTokens) > 50000 ? 'bg-emerald-500' : parseInt(qwenRateLimit.remainingTokens) > 10000 ? 'bg-amber-500' : 'bg-red-500'}`} 
                                  style={{ width: `${Math.min(100, Math.max(0, (parseInt(qwenRateLimit.remainingTokens) / 100000) * 100))}%` }}
                                ></div>
                              </div>
                            </>
                          )}
                          
                          {qwenRateLimit.resetRequests && (
                            <p className="text-slate-500 text-[10px] text-right mt-1">
                              Resets in: {Math.ceil(parseInt(qwenRateLimit.resetRequests) / 1000)}s
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        onClick={handleQwenLogin}
                        disabled={qwenAuthStatus === 'polling'}
                        className="w-full flex items-center justify-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {qwenAuthStatus === 'polling' ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Waiting for Authorization...
                          </>
                        ) : (
                          'Login via Qwen'
                        )}
                      </button>
                      
                      {qwenAuthStatus === 'polling' && qwenAuthUrl && (
                        <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-lg text-sm text-indigo-800">
                          <p className="mb-2">A new tab should have opened. If not, click the link below to authorize:</p>
                          <a href={qwenAuthUrl} target="_blank" rel="noreferrer" className="font-mono text-xs break-all underline">
                            {qwenAuthUrl}
                          </a>
                        </div>
                      )}
                      
                      {qwenAuthStatus === 'error' && (
                        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-600 flex items-start">
                          <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                          <span>{qwenAuthMessage}</span>
                        </div>
                      )}
                      
                      <p className="text-xs text-slate-500">
                        This uses the official Qwen OAuth Device Flow. Your token is securely proxied through the backend and never exposed to third parties.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Ollama Settings */}
            <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex items-center">
                  <input
                    id="useOllama"
                    type="checkbox"
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer disabled:opacity-50"
                    checked={useOllama}
                    onChange={(e) => setUseOllama(e.target.checked)}
                    disabled={loading}
                  />
                  <label htmlFor="useOllama" className="ml-2 block text-sm font-medium text-slate-700 cursor-pointer">
                    Use Local Pre-summarization (Ollama Summary)
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    id="useOllamaForFinal"
                    type="checkbox"
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer disabled:opacity-50"
                    checked={useOllamaForFinal}
                    onChange={(e) => setUseOllamaForFinal(e.target.checked)}
                    disabled={loading}
                  />
                  <label htmlFor="useOllamaForFinal" className="ml-2 block text-sm font-medium text-slate-700 cursor-pointer">
                    Use Local Model for Final Generation (Bypass Gemini)
                  </label>
                </div>
                <div className="flex items-center">
                  <input
                    id="useRag"
                    type="checkbox"
                    className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer disabled:opacity-50"
                    checked={useRag}
                    onChange={(e) => setUseRag(e.target.checked)}
                    disabled={loading}
                  />
                  <label htmlFor="useRag" className="ml-2 block text-sm font-medium text-slate-700 cursor-pointer">
                    Use RAG (Smart Context Filter)
                  </label>
                </div>
              </div>

              {(useOllama || useOllamaForFinal || useRag) && (
                <div className="space-y-4 pl-6 border-l-2 border-indigo-100 ml-2">
                  <div className="flex flex-col sm:flex-row gap-4">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-500 mb-1">Ollama URL</label>
                      <input
                        type="text"
                        value={ollamaUrl}
                        onChange={(e) => { setOllamaUrl(e.target.value); setOllamaConnected(null); }}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                      />
                    </div>
                    {(useOllama || useOllamaForFinal) && (
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-slate-500 mb-1">LLM Model Name</label>
                        {availableModels.length > 0 ? (
                          <select
                            value={ollamaModel}
                            onChange={(e) => setOllamaModel(e.target.value)}
                            className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                            disabled={loading}
                          >
                            {availableModels.map(m => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={ollamaModel}
                            onChange={(e) => setOllamaModel(e.target.value)}
                            placeholder="Test connection to load models"
                            className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                            disabled={loading}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  
                  {useRag && (
                    <div className="flex flex-col gap-4 p-3 bg-indigo-50/50 rounded-lg border border-indigo-100">
                      <div className="w-full">
                        <label className="block text-xs font-medium text-indigo-700 mb-1">Target Components (RAG Search Query)</label>
                        <input
                          type="text"
                          value={ragQuery}
                          onChange={(e) => setRagQuery(e.target.value)}
                          placeholder="e.g., authentication flow, database models, payment gateway..."
                          className="block w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                          disabled={loading}
                        />
                        <p className="mt-1 text-[10px] text-indigo-500">Leave empty to auto-generate based on the selected template.</p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex-1">
                          <label className="block text-xs font-medium text-indigo-700 mb-1">Embedding Model (RAG)</label>
                          {availableModels.length > 0 ? (
                            <select
                              value={ragModel}
                            onChange={(e) => setRagModel(e.target.value)}
                            className="block w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                            disabled={loading}
                          >
                            <option value="" disabled>Select an embedding model...</option>
                            {availableModels.map(m => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={ragModel}
                            onChange={(e) => setRagModel(e.target.value)}
                            placeholder="e.g., nomic-embed-text"
                            className="block w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                            disabled={loading}
                          />
                        )}
                        <p className="mt-1 text-[10px] text-indigo-500">Must be an embedding model (e.g., nomic-embed-text)</p>
                      </div>
                      <div className="w-full sm:w-32">
                        <label className="block text-xs font-medium text-indigo-700 mb-1">Top K Chunks</label>
                        <input
                          type="number"
                          value={ragTopK}
                          onChange={(e) => setRagTopK(Number(e.target.value))}
                          className="block w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                          disabled={loading}
                          min={1}
                          max={50}
                        />
                      </div>
                      <div className="flex-1">
                        <div className="flex justify-between items-center mb-1">
                          <label className="block text-xs font-medium text-indigo-700">Search Strategy</label>
                          <span className="text-[10px] font-mono text-indigo-500 bg-indigo-100 px-1.5 py-0.5 rounded">
                            {ragSearchStrategy < 0.4 ? '🎨 Exploration' : ragSearchStrategy > 0.6 ? '🎯 Precision' : '⚖️ Balanced'}
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          value={ragSearchStrategy}
                          onChange={(e) => setRagSearchStrategy(parseFloat(e.target.value))}
                          className="w-full h-2 bg-indigo-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                          disabled={loading}
                        />
                        <div className="flex justify-between text-[9px] text-indigo-400 mt-1 uppercase tracking-wider font-semibold">
                          <span>Ideas</span>
                          <span>Exact</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  )}

                  {useRag && (
                    <div className="pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={() => setShowAdvancedRag(!showAdvancedRag)}
                        className="flex items-center text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors"
                      >
                        <Settings2 className="w-3 h-3 mr-1" />
                        Advanced RAG Settings
                        <ChevronDown className={`w-3 h-3 ml-1 transition-transform ${showAdvancedRag ? 'rotate-180' : ''}`} />
                      </button>
                      
                      {showAdvancedRag && (
                        <div className="mt-3 space-y-2 pl-1">
                          <label className="flex items-center space-x-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={useQueryExpansion}
                              onChange={(e) => setUseQueryExpansion(e.target.checked)}
                              className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
                            />
                            <span className="text-xs text-slate-600">AI Query Expansion (Expands query with synonyms)</span>
                          </label>
                          <label className="flex items-center space-x-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={useIntentReranking}
                              onChange={(e) => setUseIntentReranking(e.target.checked)}
                              className="w-3.5 h-3.5 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
                            />
                            <span className="text-xs text-slate-600">Intent-Aware Reranking (Boosts files based on context)</span>
                          </label>
                          <div className="pt-2">
                            <button
                              type="button"
                              onClick={() => {
                                let count = 0;
                                // Need to collect keys first to avoid modifying while iterating
                                const keysToRemove = [];
                                for (let i = 0; i < localStorage.length; i++) {
                                  const key = localStorage.key(i);
                                  if (key && key.startsWith('rag_opt_')) {
                                    keysToRemove.push(key);
                                  }
                                }
                                keysToRemove.forEach(key => {
                                  localStorage.removeItem(key);
                                  count++;
                                });
                                setStatus(`Cleared ${count} cached RAG queries.`);
                                setTimeout(() => setStatus(''), 3000);
                              }}
                              className="text-xs text-red-600 hover:text-red-800 font-medium flex items-center"
                            >
                              <Trash2 className="w-3 h-3 mr-1" />
                              Clear RAG Query Cache
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                setStatus('Clearing embedding cache...');
                                await EmbeddingCacheService.clearCache();
                                setStatus('Embedding cache cleared.');
                                setTimeout(() => setStatus(''), 3000);
                              }}
                              className="text-xs text-red-600 hover:text-red-800 font-medium flex items-center"
                            >
                              <Trash2 className="w-3 h-3 mr-1" />
                              Clear Embedding Cache
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(useOllama || useOllamaForFinal) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1" title="1 token ≈ 4 characters. Increase this if the model complains about missing code.">
                          Context Window (Tokens)
                        </label>
                      <input
                        type="number"
                        value={ollamaNumCtx}
                        onChange={(e) => setOllamaNumCtx(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={1024}
                        step={1024}
                      />
                      <p className="mt-1 text-[10px] text-slate-400 leading-tight">
                        Increase if model complains about missing code. Requires more RAM/VRAM.
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Max Tokens (Summary)</label>
                      <input
                        type="number"
                        value={ollamaSummaryPredict}
                        onChange={(e) => setOllamaSummaryPredict(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={50}
                        step={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Max Tokens (Final)</label>
                      <input
                        type="number"
                        value={ollamaFinalPredict}
                        onChange={(e) => setOllamaFinalPredict(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={250}
                        step={50}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1" title="0 = No limit (Full files). Use 2000-4000 for faster generation when deep code analysis isn't needed.">
                        File Truncation (Chars)
                      </label>
                      <input
                        type="number"
                        value={fileTruncationLimit}
                        onChange={(e) => setFileTruncationLimit(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={0}
                        step={1000}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Temperature ({ollamaTemperature})</label>
                      <input
                        type="range"
                        value={ollamaTemperature}
                        onChange={(e) => setOllamaTemperature(Number(e.target.value))}
                        className="block w-full mt-2"
                        disabled={loading}
                        min={0}
                        max={1}
                        step={0.1}
                      />
                    </div>
                  </div>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleTestOllama}
                      disabled={testingOllama || loading}
                      className="text-xs px-3 py-1.5 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      {testingOllama ? 'Testing...' : 'Test Connection'}
                    </button>
                    {ollamaConnected === true && <span className="text-xs text-emerald-600 flex items-center"><Check className="w-3 h-3 mr-1"/> Connected</span>}
                    {ollamaConnected === false && <span className="text-xs text-red-600">Connection failed (Check CORS)</span>}
                  </div>
                  <div className="text-xs text-slate-500 bg-slate-100 p-3 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-700 mb-1">How to enable CORS for Ollama:</p>
                      <p>Ollama blocks cross-origin requests by default. To use it here, you must start it with <code className="bg-slate-200 px-1 py-0.5 rounded">OLLAMA_ORIGINS="{window.location.origin}"</code></p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDownloadBat}
                      className="inline-flex items-center px-3 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors whitespace-nowrap"
                    >
                      <Download className="w-3 h-3 mr-1.5" />
                      Download Windows .bat
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>

          {isTruncated && (
            <div className="mt-4 p-4 bg-amber-50 rounded-xl border border-amber-200 flex items-start">
              <AlertTriangle className="w-5 h-5 text-amber-500 mr-3 mt-0.5 flex-shrink-0" />
              <div>
                <h4 className="text-sm font-medium text-amber-800">Large Repository Detected</h4>
                <p className="text-sm text-amber-700 mt-1">
                  The repository contains too many files. The <strong>directory tree listing</strong> has been truncated to 1000 items to prevent AI context overflow. This does not affect your {maxFiles} selected source files, which are still included in full.
                </p>
              </div>
            </div>
          )}
          
          {error && (
            <div className="mt-4 p-4 bg-red-50 rounded-xl border border-red-100">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </div>

        {/* Output Area */}
        {prompt && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 rounded-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/50">
              <div className="flex items-center space-x-2 flex-wrap gap-y-2">
                <FileText className="w-5 h-5 text-slate-500" />
                <h3 className="text-sm font-medium text-slate-900">{generatedFileName}</h3>
                {usedModel && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">
                    Model: {usedModel}
                  </span>
                )}
                {lastOptimizedQuery && (
                  <div className="ml-2 flex items-center space-x-1">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800" title="Detected Intent">
                      {lastOptimizedQuery.intent}
                    </span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 truncate max-w-[200px]" title={`Optimized Query: ${lastOptimizedQuery.query}`}>
                      RAG: {lastOptimizedQuery.query}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center px-3 py-1.5 border border-slate-300 shadow-sm text-xs font-medium rounded-lg text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 mr-1.5 text-emerald-500" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1.5 text-slate-400" />
                      Copy
                    </>
                  )}
                </button>
                <button
                  onClick={handleDownload}
                  className="inline-flex items-center px-3 py-1.5 border border-slate-300 shadow-sm text-xs font-medium rounded-lg text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
                >
                  <Download className="w-4 h-4 mr-1.5 text-slate-400" />
                  Download
                </button>
              </div>
            </div>
            <div className="p-6 overflow-x-auto">
              <pre className="text-sm font-mono text-slate-800 whitespace-pre-wrap break-words">
                {prompt.length > 50000 
                  ? prompt.substring(0, 50000) + '\n\n... [⚠️ PREVIEW TRUNCATED FOR PERFORMANCE ⚠️]\n... [The full prompt is too large to display in the browser without lagging.]\n... [Please use the "Copy" or "Download" buttons above to get the full text.]' 
                  : prompt}
              </pre>
            </div>
          </div>
        )}

      </div>

      {/* Sticky Bottom Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-md border-t border-slate-200 p-4 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-40">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            {status && loading && (
              <p className="text-sm font-medium text-indigo-600 animate-pulse truncate">
                {status}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {loading && (
              <button
                type="button"
                onClick={cancelGeneration}
                className="inline-flex items-center justify-center px-4 py-2 border border-slate-300 text-sm font-medium rounded-xl text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
              >
                <X className="-ml-1 mr-2 h-4 w-4" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={loading || (inputMode === 'github' ? !url : (!localFiles || localFiles.length === 0))}
              className="inline-flex items-center justify-center px-6 py-2 border border-transparent text-sm font-medium rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                  Generating...
                </>
              ) : (
                inputMode === 'github' && cachedRepoData && cacheKey === `${url}-${githubToken}-${maxFiles}` ? 'Regenerate (Cached)' : 'Generate Prompt'
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Token Warning Modal */}
      {tokenWarningResolver && tokenWarning && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6">
            <div className="flex items-center gap-3 text-amber-600 mb-4">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="text-lg font-semibold text-slate-900">Context Limits Conflict</h3>
            </div>
            <div className="text-sm text-slate-600 space-y-3 mb-6">
              <p>
                Your input prompt (code + instructions) is approximately <strong>~{tokenWarning.inputTokens} tokens</strong>.
              </p>
              <p>
                With your current <code>Context Window</code> ({ollamaNumCtx}), only <strong>~{tokenWarning.availableTokens} tokens</strong> remain for the model's response.
              </p>
              <p>
                However, you requested <code>Max Tokens (Final)</code> = {tokenWarning.requestedTokens}.
              </p>
              <div className="bg-amber-50 border border-amber-200 p-3 rounded-lg text-amber-800">
                If you proceed, Ollama will <strong>truncate the beginning of your prompt</strong> (the system instructions) to fit the limits, which may cause the model to ignore your formatting rules or task description.
              </div>
              <p className="font-medium text-slate-900 mt-4">Recommendations:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Increase <code>Context Window</code> to {tokenWarning.inputTokens + tokenWarning.requestedTokens + 500} (if your RAM allows).</li>
                <li>Or decrease <code>Max Tokens (Final)</code> to {Math.max(500, tokenWarning.availableTokens - 200)}.</li>
              </ul>
              <div className="mt-4 bg-red-50 border border-red-200 p-3 rounded-lg text-red-800 text-xs">
                <strong>⚠️ Hardware Warning:</strong> The <code>Context Window</code> is passed directly to Ollama, overriding its default. Setting it to 20,000+ tokens requires massive amounts of RAM/VRAM (especially for 24B+ models). If your system (e.g., 16GB/32GB RAM) cannot allocate the KV cache, Ollama may crash, freeze your system, or return an Out Of Memory error.
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row gap-3 justify-end">
              <button
                onClick={() => tokenWarningResolver(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancel (Change Settings)
              </button>
              <button
                onClick={() => tokenWarningResolver(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors"
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
