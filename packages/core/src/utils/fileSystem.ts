import { isTauri, tauriInvoke } from "./tauriAdapter";

export const saveMarkdownFile = async (
  content: string,
  defaultFilename: string = "README.md",
) => {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const filePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (filePath) {
        await tauriInvoke("save_text_file", { path: filePath, content });
      }
    } catch (e) {
      console.error("Failed to save file in Tauri:", e);
    }
  } else {
    downloadWebFile(content, defaultFilename);
  }
  return true;
};

const downloadWebFile = (content: string, filename: string) => {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const pickLocalDirectoryNative = async (
  title: string = "Select Repository Folder",
): Promise<string | null> => {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title,
    });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    console.error("Failed to open folder picker in Tauri:", e);
    return null;
  }
};

