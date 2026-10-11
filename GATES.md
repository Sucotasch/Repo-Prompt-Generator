# GATES — Desktop version full audit

Scope: apps/desktop/src-tauri/**, apps/desktop/src/**, Tauri-specific paths in packages/**

- [x] G1: Command contract inventory is complete — every `#[tauri::command]` and every `tauriInvoke` call site cross-checked (args vs Rust signature, honoring `rename_all`), tool validated by negative control
  CHECK: node .unlazy/audit/contract-check.mjs
  EXPECT: INVENTORY OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Arx\Software Downloads\_Images_EDIT-pack\Repo-Prompt-Generator; path=c2239f09532c/99 entries; EXPECT=matched; output-sha256=1ecc75b66786674ec30342d44273b51e148e2e588f607924e8af83b2822a3b0a; output-bytes=67

- [x] G2: Report AUDIT_DESKTOP.md is complete and honest — all 14 scope files referenced, every file:line citation in bounds, findings counted
  CHECK: node .unlazy/audit/report-check.mjs
  EXPECT: REPORT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Arx\Software Downloads\_Images_EDIT-pack\Repo-Prompt-Generator; path=c2239f09532c/99 entries; EXPECT=matched; output-sha256=252f3fdf8ce4eb115d50841c21f3c458b5e410b43651fd6cc3672657bd7cd9af; output-bytes=59

- [x] G3: Each HIGH finding re-verified against source (quotes match, cancellation flow traced)
  EVIDENCE: F-01 re-read at lib.rs:276-278 — no status check between send_async and JSON parse (the sibling info request at lib.rs:250-252 does check status, confirming the omission is real); F-02 traced: signal created at App.tsx:883 and consumed by nothing (delay() has zero call sites), ollamaService.ts:48-55 passes no cancellation argument, history-save effect fires on prompt regardless of cancel — details in AUDIT_DESKTOP.md section "G3 (manual gate)".

- [x] G4: Every open finding has a verified solution block (SOL-*) with evidence of consequences checked (prototypes/tracing), no code changes applied yet
  CHECK: node .unlazy/audit/report-check.mjs
  EXPECT: REPORT OK
  EVIDENCE: exit=0; shell=C:\WINDOWS\system32\cmd.exe; cwd=D:\Arx\Software Downloads\_Images_EDIT-pack\Repo-Prompt-Generator; path=c2239f09532c/99 entries; EXPECT=matched; output-sha256=e177946cd537618332684c5e27dc143047744b4d8f1d8829656d8e4c1f33d4ca; output-bytes=79
