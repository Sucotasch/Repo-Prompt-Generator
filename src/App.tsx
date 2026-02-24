import React, { useState } from 'react';
import { Github, FileText, Loader2, Copy, Check, Download } from 'lucide-react';
import { fetchRepoData } from './services/githubService';
import { generateSystemPrompt } from './services/geminiService';
import { checkOllamaConnection, summarize_with_ollama, fetchOllamaModels } from './services/ollamaService';

export default function App() {
  const [url, setUrl] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [analyzeIssues, setAnalyzeIssues] = useState(false);
  const [useOllama, setUseOllama] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3');
  const [ollamaNumCtx, setOllamaNumCtx] = useState(8192);
  const [ollamaNumPredict, setOllamaNumPredict] = useState(250);
  const [ollamaTemperature, setOllamaTemperature] = useState(0.3);
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testingOllama, setTestingOllama] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState('');

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
    const batContent = `@echo off\ncolor 0A\necho ==========================================\necho Starting Ollama with CORS enabled...\necho You can now use the Gemini Prompt Generator!\necho ==========================================\nset OLLAMA_ORIGINS="*"\nollama serve\npause`;
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

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setPrompt(null);
    setCopied(false);

    try {
      setStatus('Fetching repository data...');
      let repoData = await fetchRepoData(url);
      
      let usedOllama = false;
      if (useOllama && ollamaConnected !== false) {
        setStatus('Summarizing with local Ollama...');
        usedOllama = true;
        
        const summarize = async (text: string) => {
           return text ? await summarize_with_ollama(text, ollamaUrl, ollamaModel, ollamaNumCtx, ollamaNumPredict, ollamaTemperature) : '';
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
      }
      
      setStatus('Generating system prompt with Gemini...');
      const generatedPrompt = await generateSystemPrompt(repoData, additionalContext, analyzeIssues, usedOllama);
      
      setPrompt(generatedPrompt);
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
      a.download = 'gemini.md';
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
          <form onSubmit={handleGenerate} className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row gap-4">
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
              <button
                type="submit"
                disabled={loading || !url}
                className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5" />
                    Generating...
                  </>
                ) : (
                  'Generate Prompt'
                )}
              </button>
            </div>
            
            <div className="mt-2">
              <label htmlFor="additionalContext" className="block text-sm font-medium text-slate-700 mb-2">
                Additional Context (Optional)
              </label>
              <textarea
                id="additionalContext"
                rows={3}
                placeholder="e.g., I'm planning to add GPU acceleration support for Nvidia RTX 4xxx series..."
                className="block w-full px-3 py-3 border border-slate-300 rounded-xl leading-5 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow resize-y"
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                disabled={loading}
              />
              <p className="mt-2 text-xs text-slate-500">
                Provide any specific goals, future directions, or constraints you want the AI to know about.
              </p>
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
              <div className="flex items-center mb-4">
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

              {useOllama && (
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
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-500 mb-1">Model Name</label>
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
                  </div>

                  <div className="flex flex-col sm:flex-row gap-4">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-500 mb-1">Context Window (num_ctx)</label>
                      <input
                        type="number"
                        value={ollamaNumCtx}
                        onChange={(e) => setOllamaNumCtx(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={1024}
                        step={1024}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-500 mb-1">Max Tokens (num_predict)</label>
                      <input
                        type="number"
                        value={ollamaNumPredict}
                        onChange={(e) => setOllamaNumPredict(Number(e.target.value))}
                        className="block w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-indigo-500 focus:border-indigo-500"
                        disabled={loading}
                        min={50}
                        step={50}
                      />
                    </div>
                    <div className="flex-1">
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
                      <p>Ollama blocks cross-origin requests by default. To use it here, you must start it with <code className="bg-slate-200 px-1 py-0.5 rounded">OLLAMA_ORIGINS="*"</code></p>
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
              <div className="flex items-center space-x-2">
                <FileText className="w-5 h-5 text-slate-500" />
                <h3 className="text-sm font-medium text-slate-900">gemini.md</h3>
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
                {prompt}
              </pre>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
