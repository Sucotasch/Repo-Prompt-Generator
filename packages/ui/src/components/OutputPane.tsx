import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import { isTauri } from "@repo-prompt-generator/core";
import { OptimizedQueryInfo } from "../types/ui";

interface OutputPaneProps {
  loading: boolean;
  status: string;
  error: string | null;
  onDismissError: () => void;
  isTruncated: boolean;
  maxFiles: number;
  prompt: string | null;
  generatedFileName: string;
  usedModel: string | null;
  lastOptimizedQuery: OptimizedQueryInfo | null;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
  summaryInfo: {
    sourceLabel: string;
    templateLabel: string;
    providerLabel: string;
    ragLabel: string;
  };
}

export function OutputPane({
  loading,
  status,
  error,
  onDismissError,
  isTruncated,
  maxFiles,
  prompt,
  generatedFileName,
  usedModel,
  lastOptimizedQuery,
  copied,
  onCopy,
  onDownload,
  summaryInfo,
}: OutputPaneProps) {
  return (
    <div className="h-full flex flex-col bg-slate-50/60 min-h-0">
      {/* Live Status Strip */}
      {(loading || status) && (
        <div className="px-5 py-2.5 border-b border-slate-200 bg-white flex items-center gap-2 text-xs font-medium text-slate-700 shrink-0">
          {loading && (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600 shrink-0" />
          )}
          <span className="truncate">{status || "Processing..."}</span>
        </div>
      )}

      {/* Alerts */}
      {error && (
        <div className="mx-5 mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-start justify-between gap-3 shrink-0">
          <div className="flex items-start gap-2 text-xs text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-800 shrink-0 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {isTruncated && (
        <div className="mx-5 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md flex items-start gap-2 text-xs text-amber-800 shrink-0">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <strong>Large Repository:</strong> File tree listing truncated to
            1,000 entries to stay within context budget. Your{" "}
            <span className="tabular-nums font-medium">{maxFiles}</span>{" "}
            selected source files remain included in full.
          </div>
        </div>
      )}

      {prompt ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Unboxed Output Toolbar Header */}
          <div className="px-5 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                <span className="text-xs font-semibold font-mono text-slate-900 truncate">
                  {generatedFileName}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5 truncate tabular-nums">
                {[
                  usedModel || null,
                  lastOptimizedQuery ? `Intent: ${lastOptimizedQuery.intent}` : null,
                  lastOptimizedQuery
                    ? `RAG: ${lastOptimizedQuery.query}`
                    : null,
                  `${prompt.length.toLocaleString()} chars`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onCopy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-xs font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-500" />
                    <span>Copy</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onDownload}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-xs font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-slate-500" />
                <span>Download .md</span>
              </button>
            </div>
          </div>

          {/* Scrollable Monospace Output */}
          <div className="flex-1 min-h-0 overflow-y-auto p-5 bg-white">
            <pre className="text-[13px] leading-relaxed font-mono text-slate-800 whitespace-pre-wrap break-words">
              {prompt.length > 50000
                ? prompt.substring(0, 50000) +
                  '\n\n... [PREVIEW TRUNCATED FOR PERFORMANCE]\n... [Full prompt exceeds 50,000 characters. Use Copy or Download .md above for the complete output.]'
                : prompt}
            </pre>
          </div>
        </div>
      ) : (
        /* Informative Pipeline Readiness Empty State */
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md w-full border border-slate-200 rounded-lg bg-white p-5 space-y-4">
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-indigo-600 shrink-0" />
              <h3 className="text-sm font-semibold text-slate-900">
                Pipeline Ready
              </h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Configure your repository source and instructions on the left,
              then click <strong>Generate Prompt</strong> in the header.
            </p>
            <dl className="divide-y divide-slate-100 border-t border-slate-200 text-xs">
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Environment</dt>
                <dd className="font-mono text-slate-800 truncate">
                  {isTauri() ? "Desktop (Tauri)" : "Web Studio"}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Source</dt>
                <dd className="font-mono text-slate-800 truncate">
                  {summaryInfo.sourceLabel}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Template</dt>
                <dd className="font-mono text-slate-800 truncate">
                  {summaryInfo.templateLabel}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Model</dt>
                <dd className="font-mono text-slate-800 truncate">
                  {summaryInfo.providerLabel}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between gap-4">
                <dt className="text-slate-500 shrink-0">Retrieval</dt>
                <dd className="font-mono text-slate-800 truncate">
                  {summaryInfo.ragLabel}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
