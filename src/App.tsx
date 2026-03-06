import React, { useState, useEffect } from 'react';
import { Github, FileText, Loader2, Copy, Check, Download, Settings2, AlertTriangle, Save, Trash2, Folder, ChevronDown, Database, Paperclip, X } from 'lucide-react';
import { fetchRepoData } from './services/githubService';
import { processLocalFolder } from './services/localFileService';
import { generateSystemPrompt, buildPromptText, rewriteQueryWithGemini } from './services/geminiService';
import { checkOllamaConnection, summarize_with_ollama, fetchOllamaModels, generate_final_prompt_with_ollama, rewriteQueryWithOllama } from './services/ollamaService';
import { performRAG } from './services/ragService';

const TEMPLATES = {
  default: `You are an expert software engineer and AI assistant. Based on the following GitHub repository information, generate a comprehensive system prompt suitable for further development of the project using Gemini CLI or Antigravity. The prompt should be formatted as markdown, ready to be saved as \`gemini.md\`.

Generate a system prompt that includes:
1. The project's purpose and tech stack.
2. The architectural patterns and conventions used.
3. Instructions for the AI on how to assist with this specific codebase.
4. Any specific rules or guidelines for contributing to this project.`,
  
  audit: `You are an expert Principal Software Engineer conducting a rigorous code audit. Do not rely solely on the README; perform a deep analysis of the provided codebase.

Your audit must include:
1. **Algorithm & Architecture**: A detailed, step-by-step description of the core algorithms and data flow.
2. **Defect Identification**: Pinpoint logical errors, dead code (non-functional functions), bugs, race conditions, and bottlenecks.
3. **Performance Impact**: Analyze any adverse performance impacts caused by the identified deficiencies (e.g., memory leaks, O(n^2) loops).
4. **Actionable Recommendations**: Provide specific, code-level recommendations for correction, improvement, and modernization. 

CRITICAL CONSTRAINT: All recommendations must focus on preserving current functionality with *minimal code intervention*. Do not suggest complete rewrites unless absolutely necessary. Format the output as a structured Markdown report.`,

  integration: `You are an expert Principal Software Architect specializing in system integration, code migration, and architectural review. 
You are provided with two distinct codebases:
1. **[TARGET_REPO]**: The project you need to analyze and potentially modify.
2. **[REFERENCE_REPO]**: The library, SDK, or example project proposed for integration or as a source of architectural patterns.

Your task is to critically evaluate the user's request to integrate concepts or code from [REFERENCE_REPO] into [TARGET_REPO]. Do not blindly execute the integration; first, assess its feasibility and value.

Your analysis MUST include the following sections in a structured Markdown report:

1. **Feasibility & Impact Analysis**:
   - Evaluate the architectural fit: Does [REFERENCE_REPO] align with the current stack and paradigms of [TARGET_REPO]?
   - Identify the benefits and risks/costs.
   - Provide a definitive verdict: Is this integration recommended, partially recommended, or strongly discouraged?
   - *If the user has not specified a particular feature to integrate, proactively analyze both codebases and identify the top 1-3 architectural patterns, utilities, or features from [REFERENCE_REPO] that would provide the most value if integrated into [TARGET_REPO].*

2. **Architectural Mapping** (If recommended or partially recommended):
   - Explain conceptually how the components of [REFERENCE_REPO] map to the existing structures in [TARGET_REPO].
   - Highlight any architectural bottlenecks or conflicts.

3. **Integration Plan & Code Implementation** (If recommended):
   - Provide a step-by-step migration or integration plan.
   - Identify the exact files in [TARGET_REPO] that need to change.
   - Supply the actual code snippets, strictly basing your API calls, class names, and patterns on the code found in [REFERENCE_REPO]. Do not hallucinate methods.

CRITICAL RULES & GUARDRAILS:
1. **Domain Preservation (CRITICAL)**: The core purpose, business logic, and domain terminology of [TARGET_REPO] MUST remain completely unchanged. Do not import domain-specific concepts, terminology, or features from [REFERENCE_REPO].
2. **Pattern Extraction Only**: Treat [REFERENCE_REPO] STRICTLY as a source of technical patterns, architectural solutions, APIs, or algorithms. Abstract these technical solutions away from their original business context before applying them to [TARGET_REPO].
3. **Read-Only Reference**: DO NOT modify the [REFERENCE_REPO]. It is read-only context.
4. **Minimal Intervention**: If integration is recommended, do it with the least possible disruption to the existing [TARGET_REPO] architecture.`,

  security: `You are an expert cybersecurity auditor. Analyze the provided GitHub repository data to identify hidden threats, dangerous system calls, and data exfiltration mechanisms. Look for "holes", intentionally malicious code, and vulnerabilities (SQL injections, insecure system calls, hardcoded keys, hidden requests to external IPs, socket usage, unauthorized URL access). 

Highlight the use of functions that execute system commands (e.g., eval, exec, subprocess, os.system, P/Invoke) that could lead to RCE. Find attempts to read confidential files (.env, .ssh/id_rsa, /etc/passwd, browser configs) or access Keychain/Credential Manager. Check for obfuscation, strange Base64 strings, or on-the-fly decrypted data blocks. Check the dependencies for "typosquatting".

Provide a detailed report in Markdown, ending with a Risk Assessment (Low/Medium/High) and a list of all suspicious fragments.`,

  docs: `You are an expert technical writer and software architect. Analyze the provided GitHub repository data to create comprehensive technical documentation in Markdown format (suitable for a Wiki or a detailed README.md). Make the code understandable.

Include:
1. Real capabilities of the program.
2. Algorithm of operation and architecture.
3. Installation and configuration process.
4. Examples of using the main functions.`,

  eli5: `Explain what this repository does as if I am a 5-year-old child, but focus heavily on safety. 

Tell me in very simple, funny, and exaggerated (but accurate) terms:
1. What does this code actually do? (e.g., "It draws pictures of cats" or "It's a boring calculator").
2. Is it safe to run? 
3. If it's dangerous, warn me dramatically! (e.g., "Don't even think about running this! It's a malicious joke that will encrypt your C: drive!").
4. If it's just old or broken, tell me (e.g., "Nothing scary will happen, but it probably won't even run because the code is older than your grandma. You can look at it to learn, but don't try to make it work for you.").

Keep the tone light, entertaining, and extremely easy to understand, but ensure the safety assessment is completely accurate based on the code provided.`,

  custom: ''
};

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

  const [templateMode, setTemplateMode] = useState<string>('default');
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>(() => {
    try {
      const saved = localStorage.getItem('gemini_custom_templates');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [customInstruction, setCustomInstruction] = useState(TEMPLATES.default);
  const [additionalContext, setAdditionalContext] = useState('');
  const [ragQuery, setRagQuery] = useState('');
  const [attachedDocs, setAttachedDocs] = useState<{name: string, content: string}[]>([]);
  const [analyzeIssues, setAnalyzeIssues] = useState(false);
  const [useOllama, setUseOllama] = useState(initialSettings.useOllama || false);
  const [useOllamaForFinal, setUseOllamaForFinal] = useState(initialSettings.useOllamaForFinal || false);
  const [useRag, setUseRag] = useState(initialSettings.useRag || false);
  const [ragModel, setRagModel] = useState(initialSettings.ragModel || 'nomic-embed-text');
  const [ragTopK, setRagTopK] = useState(initialSettings.ragTopK || 10);
  const [ollamaUrl, setOllamaUrl] = useState(initialSettings.ollamaUrl || 'http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState(initialSettings.ollamaModel || 'llama3');
  const [ollamaNumCtx, setOllamaNumCtx] = useState(initialSettings.ollamaNumCtx || 8192);
  const [ollamaSummaryPredict, setOllamaSummaryPredict] = useState(initialSettings.ollamaSummaryPredict || 500);
  const [ollamaFinalPredict, setOllamaFinalPredict] = useState(initialSettings.ollamaFinalPredict || 2000);
  const [ollamaTemperature, setOllamaTemperature] = useState(initialSettings.ollamaTemperature !== undefined ? initialSettings.ollamaTemperature : 0.3);
  const [useQueryExpansion, setUseQueryExpansion] = useState(initialSettings.useQueryExpansion !== undefined ? initialSettings.useQueryExpansion : true);
  const [useIntentReranking, setUseIntentReranking] = useState(initialSettings.useIntentReranking !== undefined ? initialSettings.useIntentReranking : true);
  const [showAdvancedRag, setShowAdvancedRag] = useState(false);
  
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testingOllama, setTestingOllama] = useState(false);
  const [loading, setLoading] = useState(false);
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
  
  // Cache state
  const [cachedRepoData, setCachedRepoData] = useState<any>(null);
  const [cacheKey, setCacheKey] = useState<string>('');

  useEffect(() => {
    const settings = {
      inputMode,
      githubToken,
      maxFiles,
      useOllama,
      useOllamaForFinal,
      useRag,
      ragModel,
      ragTopK,
      ollamaUrl,
      ollamaModel,
      ollamaNumCtx,
      ollamaSummaryPredict,
      ollamaFinalPredict,
      ollamaTemperature,
      useQueryExpansion,
      useIntentReranking
    };
    localStorage.setItem('gemini_app_settings', JSON.stringify(settings));
  }, [inputMode, githubToken, maxFiles, useOllama, useOllamaForFinal, useRag, ragModel, ragTopK, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaSummaryPredict, ollamaFinalPredict, ollamaTemperature, useQueryExpansion, useIntentReranking]);

  const handleTemplateChange = (mode: string) => {
    setTemplateMode(mode);
    if (mode in TEMPLATES) {
      setCustomInstruction(TEMPLATES[mode as keyof typeof TEMPLATES]);
    } else if (mode === 'custom') {
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

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputMode === 'github' && !url) return;
    if (inputMode === 'local' && (!localFiles || localFiles.length === 0)) return;
    
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

      // Generate file name
      let projectName = 'project';
      if (repoData.info && repoData.info.repo) {
        projectName = repoData.info.repo;
      }
      const templateName = templateMode === 'default' ? 'gemini' : templateMode;
      const date = new Date();
      const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
      setGeneratedFileName(`${projectName}_${templateName}_${timestamp}.md`);

      let referenceRepoData;
      if (templateMode === 'integration') {
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
      
      if (useRag && repoData.sourceFiles && repoData.sourceFiles.length > 0) {
        try {
          let optimizedQuery = ragQuery;
          let queryIntent = 'GENERAL';
          if (ragQuery.trim() !== '') {
            if (useQueryExpansion || useIntentReranking) {
              setStatus('Optimizing RAG query with LLM...');
              try {
                let result;
                if (useOllamaForFinal) {
                  result = await rewriteQueryWithOllama(ragQuery, ollamaUrl, ollamaModel);
                } else {
                  result = await rewriteQueryWithGemini(ragQuery);
                }
                
                if (useQueryExpansion) {
                  optimizedQuery = result.optimizedQuery;
                }
                if (useIntentReranking) {
                  queryIntent = result.intent;
                }
                
                setLastOptimizedQuery({ query: optimizedQuery, intent: queryIntent });
                console.log("Original RAG query:", ragQuery);
                console.log("Optimized RAG query:", optimizedQuery);
                console.log("Detected Intent:", queryIntent);
              } catch (e) {
                console.warn("Query optimization failed, using original query", e);
                setLastOptimizedQuery(null);
              }
            } else {
              setLastOptimizedQuery({ query: optimizedQuery, intent: 'GENERAL' });
            }
          } else {
             setLastOptimizedQuery(null);
          }

          const getFallbackQuery = () => {
            if (templateMode === 'audit') return "core logic, complex algorithms, potential bugs, performance bottlenecks, architecture";
            if (templateMode === 'security') return "security vulnerabilities, authentication, authorization, cryptography, network requests, file access, user input validation";
            if (templateMode === 'docs') return "main entry points, exported functions, public API, core architecture, high-level modules";
            if (templateMode === 'integration') return "system architecture, main components, interfaces, exported functions, core business logic, data models";
            if (templateMode === 'eli5') return "core functionality, main purpose, basic structure, simple logic";
            return customInstruction.substring(0, 500);
          };
          
          const finalRagQuery = (optimizedQuery || getFallbackQuery()).substring(0, 1000);

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
            ragTopK,
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
              ragTopK,
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
      if (useOllamaForFinal && ollamaConnected !== false) {
        setStatus('Generating final prompt with local Ollama...');
        const promptText = buildPromptText(repoData, customInstruction, additionalContext, analyzeIssues, referenceRepoData, attachedDocs);
        generatedPrompt = await generate_final_prompt_with_ollama(promptText, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaFinalPredict, ollamaTemperature);
        
        finalModel = `Ollama (${ollamaModel})`;

        if (usedOllama) {
          generatedPrompt = `> **Note:** This prompt was fully generated and pre-processed by a local LLM.\n\n` + generatedPrompt;
        } else {
          generatedPrompt = `> **Note:** This prompt was generated by a local LLM.\n\n` + generatedPrompt;
        }
      } else {
        setStatus('Generating system prompt with Gemini...');
        const result = await generateSystemPrompt(repoData, customInstruction, additionalContext, analyzeIssues, usedOllama, referenceRepoData, attachedDocs);
        generatedPrompt = result.text;
        finalModel = result.modelVersion;
      }
      
      setPrompt(generatedPrompt);
      setUsedModel(finalModel);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred.');
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

  const handleDownload = () => {
    if (prompt) {
      const blob = new Blob([prompt], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = generatedFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
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
              <button
                type="submit"
                disabled={loading || (inputMode === 'github' ? !url : (!localFiles || localFiles.length === 0))}
                className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                    Generating...
                  </>
                ) : (
                  inputMode === 'github' && cachedRepoData && cacheKey === `${url}-${githubToken}-${maxFiles}` ? 'Regenerate Prompt (Cached)' : 'Generate Prompt'
                )}
              </button>
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

            {templateMode === 'integration' && (
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
              <div className="flex items-center mb-3">
                <Settings2 className="w-4 h-4 text-indigo-600 mr-2" />
                <label htmlFor="templateMode" className="block text-sm font-medium text-slate-700">
                  Task Template
                </label>
              </div>
              <select
                id="templateMode"
                value={templateMode}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white mb-3"
                disabled={loading}
              >
                <optgroup label="Built-in Templates">
                  <option value="default">Default (gemini.md System Prompt)</option>
                  <option value="audit">Code Audit (Deep Analysis & Fixes)</option>
                  <option value="integration">Integration & Migration Expert</option>
                  <option value="security">Security Auditor (Vulnerability Scan)</option>
                  <option value="docs">Documentation Writer (Wiki/README)</option>
                  <option value="eli5">Explain Like I'm 5 (Safety Check)</option>
                </optgroup>
                {savedTemplates.length > 0 && (
                  <optgroup label="Your Saved Templates">
                    {savedTemplates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Custom">
                  <option value="custom">Write new custom instruction...</option>
                </optgroup>
              </select>

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
                <div className="flex justify-end gap-2 mt-3">
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
                        </div>
                      )}
                    </div>
                  )}

                  {(useOllama || useOllamaForFinal) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          
          {status && loading && (
            <p className="mt-4 text-sm text-indigo-600 animate-pulse text-center sm:text-left">
              {status}
            </p>
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
    </div>
  );
}
