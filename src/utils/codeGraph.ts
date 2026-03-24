export function buildCodeDependencyGraph(sourceFiles: { path: string; content: string }[], maxChars: number = 3000): string {
  if (!sourceFiles || sourceFiles.length === 0) return '';

  const connections: Set<string> = new Set();
  
  // Regex to find imports (ES6, CommonJS)
  // Matches: import ... from 'path', import('path'), require('path')
  const importRegex = /(?:import\s+(?:.*?\s+from\s+)?|import\s*\(|require\s*\(\s*)['"](.*?)['"]/g;

  for (const file of sourceFiles) {
    let match;
    importRegex.lastIndex = 0;
    while ((match = importRegex.exec(file.content)) !== null) {
      const targetModule = match[1];
      
      // Only keep internal imports to avoid noise from node_modules
      if (targetModule.startsWith('.') || targetModule.startsWith('@/') || targetModule.startsWith('~/') || targetModule.startsWith('src/')) {
        // Clean up paths to make them shorter and more readable
        const fromPath = file.path.replace(/^.*\/src\//, 'src/').replace(/^\.\//, '');
        const toPath = targetModule.replace(/^.*\/src\//, 'src/').replace(/^\.\//, '');
        
        connections.add(`  "${fromPath}" -> "${toPath}";`);
      }
    }
  }

  if (connections.size === 0) return '';

  let out = 'digraph Codebase {\n  rankdir=LR;\n';
  
  for (const conn of connections) {
    // Check if adding this connection exceeds the max character limit
    // Leaving some buffer for the closing brace and truncation comment
    if (out.length + conn.length + 60 > maxChars) {
      out += '  // ... [Graph truncated to save context. Core architecture shown above.]\n';
      break;
    }
    out += `${conn}\n`;
  }
  
  out += '}\n';
  return out;
}
