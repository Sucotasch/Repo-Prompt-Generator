import { AlertTriangle } from "lucide-react";
import { TokenWarningState } from "../types/ui";

interface TokenWarningModalProps {
  tokenWarning: TokenWarningState | null;
  ollamaNumCtx: number;
  onResolve: ((proceed: boolean) => void) | null;
}

export function TokenWarningModal({
  tokenWarning,
  ollamaNumCtx,
  onResolve,
}: TokenWarningModalProps) {
  if (!tokenWarning || !onResolve) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-xl max-w-lg w-full p-6">
        <div className="flex items-center gap-3 text-amber-600 mb-4">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <h3 className="text-base font-semibold text-slate-900">
            Context Limits Conflict
          </h3>
        </div>
        <div className="text-xs text-slate-600 space-y-3 mb-5 leading-relaxed">
          <p>
            Your input prompt (code + instructions) is approximately{" "}
            <strong className="tabular-nums text-slate-900">
              ~{tokenWarning.inputTokens} tokens
            </strong>
            .
          </p>
          <p>
            With your current{" "}
            <code className="font-mono text-slate-800">Context Window</code> (
            <span className="tabular-nums">{ollamaNumCtx}</span>), only{" "}
            <strong className="tabular-nums text-slate-900">
              ~{tokenWarning.availableTokens} tokens
            </strong>{" "}
            remain for the response, while{" "}
            <code className="font-mono text-slate-800">Final Max Tokens</code>{" "}
            requests{" "}
            <span className="tabular-nums">{tokenWarning.requestedTokens}</span>
            .
          </p>
          <div className="bg-amber-50 border border-amber-200 p-3 rounded-md text-amber-900">
            If you proceed, Ollama will{" "}
            <strong>truncate the beginning of your prompt</strong> (including
            primary system instructions).
          </div>
          <ul className="list-disc pl-5 space-y-1 text-slate-700 tabular-nums">
            <li>
              Increase Context Window to{" "}
              {tokenWarning.inputTokens + tokenWarning.requestedTokens + 500}{" "}
              (if RAM/VRAM allows).
            </li>
            <li>
              Or lower Final Max Tokens to{" "}
              {Math.max(500, tokenWarning.availableTokens - 200)}.
            </li>
          </ul>
          <div className="bg-red-50 border border-red-200 p-3 rounded-md text-red-800">
            <strong>Hardware Notice:</strong> Very large Context Windows
            (20,000+ tokens) allocate significant KV-cache RAM/VRAM and may
            trigger OOM errors on constrained machines.
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row gap-2.5 justify-end">
          <button
            type="button"
            onClick={() => onResolve(false)}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer"
          >
            Cancel (Change Settings)
          </button>
          <button
            type="button"
            onClick={() => onResolve(true)}
            className="px-4 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors cursor-pointer"
          >
            Proceed with Truncation
          </button>
        </div>
      </div>
    </div>
  );
}
