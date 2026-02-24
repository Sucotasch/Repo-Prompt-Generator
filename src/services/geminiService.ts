import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

export async function generateSystemPrompt(
  repoData: RepoData, 
  taskInstruction: string,
  additionalContext?: string, 
  analyzeIssues?: boolean, 
  usedOllama?: boolean
): Promise<string> {
  const prompt = `--- TASK INSTRUCTION ---
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

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
  });

  let finalPrompt = response.text || "Failed to generate prompt.";
  if (usedOllama) {
    finalPrompt = `> **Note:** This context was pre-processed by local LLM.\n\n` + finalPrompt;
  }

  return finalPrompt;
}
