import React from "react";
import {
  Database,
  Folder,
  FolderOpen,
  Github,
  Paperclip,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { getAllTemplates, getTemplate, isTauri } from "@repo-prompt-generator/core";
import { useAppSettings } from "../hooks/useAppSettings";

interface SourceTaskTabProps {
  settings: ReturnType<typeof useAppSettings>;
  loading: boolean;
  onPickNativeFolder: (target: "main" | "reference") => Promise<void>;
  onError: (msg: string | null) => void;
  onStatus: (msg: string) => void;
}

export function SourceTaskTab({
  settings,
  loading,
  onPickNativeFolder,
  onError,
  onStatus,
}: SourceTaskTabProps) {
  const showReferenceSection =
    settings.templateMode === "integration" ||
    ((settings.templateMode === "custom" ||
      settings.templateMode.startsWith("user_")) &&
      settings.useReferenceRepo);

  const selectedTemplate = getTemplate(settings.templateMode);
  const maxAllowedFiles =
    settings.inputMode === "local" ? 200 : settings.githubToken ? 200 : 10;
  const maxRefAllowedFiles =
    settings.referenceInputMode === "local"
      ? 200
      : settings.githubToken
        ? 200
        : 10;

  return (
    <div className="divide-y divide-slate-200">
      {/* Target Repository Section */}
      <section className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Target Repository
          </h2>
          <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => settings.setInputMode("github")}
              disabled={loading}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                settings.inputMode === "github"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Github className="w-3.5 h-3.5" />
              <span>GitHub</span>
            </button>
            <button
              type="button"
              onClick={() => settings.setInputMode("local")}
              disabled={loading}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                settings.inputMode === "local"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Folder className="w-3.5 h-3.5" />
              <span>Local Folder</span>
            </button>
          </div>
        </div>

        {settings.inputMode === "github" ? (
          <div className="space-y-3">
            <div>
              <label
                htmlFor="repoUrl"
                className="block text-xs font-medium text-slate-600 mb-1"
              >
                Repository URL
              </label>
              <div className="relative">
                <Github className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="repoUrl"
                  type="url"
                  placeholder="https://github.com/owner/repo"
                  value={settings.url}
                  onChange={(e) => settings.setUrl(e.target.value)}
                  disabled={loading}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-md bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="githubToken"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  GitHub Token (Optional)
                </label>
                <input
                  id="githubToken"
                  type="password"
                  placeholder="ghp_..."
                  value={settings.githubToken}
                  onChange={(e) => settings.setGithubToken(e.target.value)}
                  disabled={loading}
                  className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label
                  htmlFor="maxFiles"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  Max Source Files (1–{maxAllowedFiles})
                </label>
                <input
                  id="maxFiles"
                  type="number"
                  min={1}
                  max={maxAllowedFiles}
                  value={settings.maxFiles}
                  onChange={(e) => settings.setMaxFiles(Number(e.target.value))}
                  disabled={loading}
                  className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500">
              {settings.githubToken
                ? "Token set: up to 200 prioritized files can be fetched."
                : "Without token: limited to 10 prioritized files (add token to increase up to 200)."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {isTauri() ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => onPickNativeFolder("main")}
                  disabled={loading}
                  className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <FolderOpen className="w-4 h-4 text-indigo-600" />
                  <span>
                    {settings.nativeLocalPath
                      ? "Change Folder..."
                      : "Select Local Folder..."}
                  </span>
                </button>
                <span className="text-xs font-mono text-slate-600 truncate min-w-0 flex-1">
                  {settings.nativeLocalPath || "No folder selected"}
                </span>
              </div>
            ) : (
              <div>
                <input
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  onChange={(e) => {
                    e.preventDefault();
                    settings.setLocalFiles(e.target.files);
                  }}
                  disabled={loading}
                  className="block w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-medium file:bg-white file:text-slate-700 hover:file:bg-slate-50 cursor-pointer"
                />
                {settings.localFiles && settings.localFiles.length > 0 && (
                  <p className="mt-1.5 text-xs text-slate-600 tabular-nums">
                    Selected {settings.localFiles.length} files from{" "}
                    <span className="font-mono">
                      {settings.localFiles[0].webkitRelativePath?.split(
                        /[/\\]/,
                      )[0] ||
                        settings.localFiles[0].name ||
                        "local-folder"}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="max-w-[200px]">
              <label
                htmlFor="maxFilesLocal"
                className="block text-xs font-medium text-slate-600 mb-1"
              >
                Max Source Files (1–200)
              </label>
              <input
                id="maxFilesLocal"
                type="number"
                min={1}
                max={200}
                value={settings.maxFiles}
                onChange={(e) => settings.setMaxFiles(Number(e.target.value))}
                disabled={loading}
                className="w-full px-3 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
        )}
      </section>

      {/* Reference Repository Section (when applicable) */}
      {showReferenceSection && (
        <section className="p-5 bg-slate-50/70 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-indigo-600" />
              <span>Reference Repository</span>
            </h3>
            <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
              <button
                type="button"
                onClick={() => settings.setReferenceInputMode("github")}
                disabled={loading}
                className={`px-2 py-0.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                  settings.referenceInputMode === "github"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                GitHub
              </button>
              <button
                type="button"
                onClick={() => settings.setReferenceInputMode("local")}
                disabled={loading}
                className={`px-2 py-0.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                  settings.referenceInputMode === "local"
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Local
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5">
            {settings.referenceInputMode === "github" ? (
              <input
                type="url"
                placeholder="https://github.com/owner/reference-repo"
                value={settings.referenceUrl}
                onChange={(e) => settings.setReferenceUrl(e.target.value)}
                disabled={loading}
                className="flex-1 px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            ) : isTauri() ? (
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => onPickNativeFolder("reference")}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-indigo-600" />
                  <span>Select Folder...</span>
                </button>
                <span className="text-xs font-mono text-slate-600 truncate min-w-0">
                  {settings.referenceNativeLocalPath || "None"}
                </span>
              </div>
            ) : (
              <div className="flex-1">
                <input
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  onChange={(e) => {
                    e.preventDefault();
                    settings.setReferenceLocalFiles(e.target.files);
                  }}
                  disabled={loading}
                  className="block w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-medium file:bg-white file:text-slate-700 hover:file:bg-slate-50 cursor-pointer"
                />
              </div>
            )}

            <div className="w-full sm:w-28 shrink-0">
              <input
                type="number"
                min={1}
                max={maxRefAllowedFiles}
                value={settings.referenceMaxFiles}
                onChange={(e) =>
                  settings.setReferenceMaxFiles(Number(e.target.value))
                }
                disabled={loading}
                title={`Max reference files (1–${maxRefAllowedFiles})`}
                className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
        </section>
      )}

      {/* Task Template Section */}
      <section className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="templateMode"
            className="text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Task Template
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => settings.handleExportTemplates(onError)}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer"
            >
              Export
            </button>
            <label className="text-xs font-medium text-indigo-600 hover:text-indigo-800 whitespace-nowrap cursor-pointer">
              Import
              <input
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) =>
                  settings.handleImportTemplates(e, onError, onStatus)
                }
              />
            </label>
          </div>
        </div>

        <select
          id="templateMode"
          value={settings.templateMode}
          onChange={(e) => settings.handleTemplateChange(e.target.value)}
          disabled={loading}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        >
          <optgroup label="Built-in Templates">
            {getAllTemplates().map((tpl) => (
              <option key={tpl.metadata.id} value={tpl.metadata.id}>
                {tpl.metadata.name} — {tpl.metadata.description}
              </option>
            ))}
          </optgroup>
          {settings.savedTemplates.length > 0 && (
            <optgroup label="Saved Templates">
              {settings.savedTemplates.map((t) => (
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

        {selectedTemplate ? (
          <pre className="w-full px-3 py-2.5 border border-slate-200 rounded-md bg-slate-50 text-slate-600 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono text-xs leading-relaxed">
            {settings.getSystemPrompt(
              settings.templateMode,
              settings.customInstruction,
            )}
          </pre>
        ) : (
          <div className="space-y-2.5">
            <textarea
              rows={5}
              placeholder="Enter custom system instruction. The repository context (Tree, README, Dependencies, Source Files) will be appended automatically."
              value={settings.customInstruction}
              onChange={(e) => {
                settings.setCustomInstruction(e.target.value);
                if (
                  !settings.templateMode.startsWith("user_") &&
                  settings.templateMode !== "custom"
                ) {
                  settings.setTemplateMode("custom");
                }
              }}
              disabled={loading}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.useReferenceRepo}
                  onChange={(e) =>
                    settings.setUseReferenceRepo(e.target.checked)
                  }
                  disabled={loading}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                />
                <span>Include Reference Repository</span>
              </label>

              <div className="flex items-center gap-2">
                {settings.templateMode.startsWith("user_") &&
                  (settings.confirmDeleteTemplateId ===
                  settings.templateMode ? (
                    <>
                      <button
                        type="button"
                        onClick={settings.handleDeleteTemplate}
                        disabled={loading}
                        className="px-2.5 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer"
                      >
                        Confirm Delete
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          settings.setConfirmDeleteTemplateId(null)
                        }
                        className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={settings.handleDeleteTemplate}
                      disabled={loading}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 bg-red-50 hover:bg-red-100 rounded cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete</span>
                    </button>
                  ))}

                {settings.templateMode.startsWith("user_") &&
                  settings.customInstruction.trim() !== "" && (
                    <button
                      type="button"
                      onClick={settings.handleSaveTemplate}
                      disabled={loading}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save Changes</span>
                    </button>
                  )}

                {!settings.templateMode.startsWith("user_") &&
                  settings.customInstruction.trim() !== "" &&
                  (settings.isSavingNew ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={settings.newTemplateName}
                        onChange={(e) =>
                          settings.setNewTemplateName(e.target.value)
                        }
                        placeholder="Template name..."
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            settings.confirmSaveTemplate(e);
                          } else if (e.key === "Escape") {
                            settings.setIsSavingNew(false);
                          }
                        }}
                        className="px-2.5 py-1 text-xs border border-slate-300 rounded focus:ring-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={settings.confirmSaveTemplate}
                        disabled={!settings.newTemplateName.trim() || loading}
                        className="px-2.5 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded disabled:opacity-50 cursor-pointer"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => settings.setIsSavingNew(false)}
                        className="px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => settings.setIsSavingNew(true)}
                      disabled={loading}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save as Template</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Additional Context & Attachments Section */}
      <section className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="additionalContext"
            className="text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Additional Context & Constraints
          </label>
          <label className="cursor-pointer inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md whitespace-nowrap shrink-0 transition-colors">
            <Paperclip className="w-3.5 h-3.5 text-slate-500" />
            <span>Attach Docs</span>
            <input
              type="file"
              multiple
              accept=".md,.txt,.json,.csv,.log"
              className="hidden"
              onChange={(e) => settings.handleAttachDocs(e, onError)}
              disabled={loading}
            />
          </label>
        </div>

        <textarea
          id="additionalContext"
          rows={3}
          placeholder={
            settings.templateMode === "integration"
              ? "What do you want to integrate or migrate from the Reference Repo?"
              : "Specific goals, constraints, target hardware, or architecture requirements..."
          }
          value={settings.additionalContext}
          onChange={(e) => settings.setAdditionalContext(e.target.value)}
          disabled={loading}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
        />

        {settings.attachedDocs.length > 0 && (
          <div className="divide-y divide-slate-200 border border-slate-200 rounded-md bg-slate-50">
            {settings.attachedDocs.map((doc, idx) => (
              <div
                key={`${doc.name}-${idx}`}
                className="flex items-center justify-between px-3 py-1.5 text-xs text-slate-700"
              >
                <span className="font-mono truncate pr-2">{doc.name}</span>
                <button
                  type="button"
                  onClick={() => settings.removeAttachedDoc(idx)}
                  disabled={loading}
                  aria-label={`Remove ${doc.name}`}
                  className="text-slate-400 hover:text-red-600 p-0.5 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-start gap-2 pt-1 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.analyzeIssues}
            onChange={(e) => settings.setAnalyzeIssues(e.target.checked)}
            disabled={loading}
            className="mt-0.5 h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-slate-300 rounded cursor-pointer"
          />
          <span className="text-xs text-slate-700 leading-relaxed">
            Analyze repository for obvious errors, bugs, and outdated dependencies
          </span>
        </label>
      </section>
    </div>
  );
}
