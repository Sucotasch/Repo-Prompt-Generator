import { isTauri } from './tauri';

export const saveMarkdownFile = async (content: string, defaultFilename: string = 'README.md') => {
  if (isTauri()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      
      const filePath = await save({
        filters: [{
          name: 'Markdown',
          extensions: ['md']
        }],
        defaultPath: defaultFilename
      });

      if (filePath) {
        await writeTextFile(filePath, content);
        return true;
      }
      return false; // User cancelled
    } catch (e) {
      console.error('Failed to save file using Tauri API:', e);
      // Fallback to web download if Tauri API fails
      downloadWebFile(content, defaultFilename);
      return true;
    }
  } else {
    downloadWebFile(content, defaultFilename);
    return true;
  }
};

const downloadWebFile = (content: string, filename: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
