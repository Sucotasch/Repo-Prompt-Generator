import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

export function buildPromptText(
  repoData: RepoData,
  taskInstruction: string,
  additionalContext?: string,
  analyzeIssues?: boolean
): string {
  return `--- TASK INSTRUCTION ---
${taskInstruction}

--- REPOSITORY CONTEXT ---
Repository Name: ${repoData.info.owner}/${repoData.info.repo}
Description: ${repoData.info.description}

File Tree (partial):
${repoData.tree.slice(0, 500).join('\n')}

README:
${repoData.readme.substring(0, 2000)}

Dependencies:
${repoData.dependencies.substring(0, 2000)}
${repoData.sourceFiles && repoData.sourceFiles.length > 0 ? `\nKey Source Files:\n${repoData.sourceFiles.map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}\n`).join('\n')}` : ''}
${additionalContext ? `\nAdditional Context / Future Development Directions:\n${additionalContext}\n` : ''}${analyzeIssues ? `\nCRITICAL INSTRUCTION: Perform a preliminary analysis of the provided repository data. Identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Include these findings directly in the generated output.\n` : ''}`;
}

export async function generateSystemPrompt(
  repoData: RepoData,
  taskInstruction: string,
  additionalContext?: string,
  analyzeIssues?: boolean,
  usedOllama?: boolean
): Promise<{ text: string, modelVersion: string }> {
  const prompt = buildPromptText(repoData, taskInstruction, additionalContext, analyzeIssues);

  const { invoke } = await import('@tauri-apps/api/core');
  const response: string = await invoke('call_gemini_secure', { prompt });
  const data = JSON.parse(response);

  let finalPrompt = (data.candidates?.[0]?.content?.parts?.[0]?.text) || "Failed to generate prompt.";
  if (usedOllama) {
    finalPrompt = `> **Note:** This context was pre-processed by local LLM.\n\n` + finalPrompt;
  }

  // Extract model version or fallback
  const modelVersion = "gemini-3-flash-preview";

  return { text: finalPrompt, modelVersion };
}
