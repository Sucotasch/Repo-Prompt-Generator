export const saveMarkdownFile = async (content: string, defaultFilename: string = 'README.md') => {
  // Tauri support removed for web version. See CHANGELOG_WEB_TO_WIN.md
  downloadWebFile(content, defaultFilename);
  return true;
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
