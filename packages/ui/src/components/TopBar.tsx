import {
  Cpu,
  FileText,
  FolderGit2,
  Loader2,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import { WorkbenchTab } from "../types/ui";

interface TopBarProps {
  activeTab: WorkbenchTab;
  onSelectTab: (tab: WorkbenchTab) => void;
  loading: boolean;
  canGenerate: boolean;
  isRegenerateCached: boolean;
  hasPrompt: boolean;
  hasError: boolean;
  onGenerate: () => void;
  onCancel: () => void;
}

export function TopBar({
  activeTab,
  onSelectTab,
  loading,
  canGenerate,
  isRegenerateCached,
  hasPrompt,
  hasError,
  onGenerate,
  onCancel,
}: TopBarProps) {
  const navTabs: {
    id: WorkbenchTab;
    label: string;
    icon: typeof FolderGit2;
    mobileOnly?: boolean;
  }[] = [
    { id: "source", label: "Source & Task", icon: FolderGit2 },
    { id: "provider", label: "AI & Gemini", icon: SlidersHorizontal },
    { id: "rag", label: "RAG & Local LLM", icon: Cpu },
    { id: "output", label: "Output", icon: Terminal, mobileOnly: true },
  ];

  const effectiveDesktopTab: WorkbenchTab =
    activeTab === "output" ? "source" : activeTab;

  return (
    <header className="h-14 border-b border-slate-200 bg-white px-4 lg:px-6 flex items-center justify-between gap-3 shrink-0 z-30">
      <div className="flex items-center gap-2.5 min-w-0 shrink-0">
        <div className="w-7 h-7 rounded-md bg-slate-900 text-white flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-slate-900 whitespace-nowrap">
          Repo Prompt
        </span>
      </div>

      <nav
        aria-label="Workbench Sections"
        className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0"
      >
        {navTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.mobileOnly
            ? activeTab === "output"
            : activeTab === tab.id ||
              (activeTab === "output" && effectiveDesktopTab === tab.id);

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                tab.mobileOnly ? "lg:hidden" : ""
              } ${
                isActive
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
              }`}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span>{tab.label}</span>
              {tab.id === "output" && (hasPrompt || hasError || loading) && (
                <span
                  className={`w-1.5 h-1.5 rounded-[1px] shrink-0 ${
                    hasError
                      ? "bg-red-500"
                      : loading
                        ? "bg-indigo-400"
                        : "bg-emerald-500"
                  }`}
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2 shrink-0">
        {loading && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-xs font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Cancel</span>
          </button>
        )}
        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-semibold rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap shrink-0 transition-colors cursor-pointer"
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              <span>Generating...</span>
            </>
          ) : isRegenerateCached ? (
            <span>Regenerate (Cached)</span>
          ) : (
            <span>Generate Prompt</span>
          )}
        </button>
      </div>
    </header>
  );
}
