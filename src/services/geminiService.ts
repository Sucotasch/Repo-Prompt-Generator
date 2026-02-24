import { GoogleGenAI } from "@google/genai";
import { RepoData } from "./githubService";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateSystemPrompt(repoData: RepoData, additionalContext?: string, analyzeIssues?: boolean, usedOllama?: boolean): Promise<string> {
  const prompt = `You are an expert software engineer and AI assistant. Based on the following GitHub repository information, generate a comprehensive system prompt suitable for further development of the project using Gemini CLI or Antigravity. The prompt should be formatted as markdown, ready to be saved as \`gemini.md\`.

Repository Name: ${repoData.info.owner}/${repoData.info.repo}
Description: ${repoData.info.description}

File Tree (partial):
${repoData.tree.slice(0, 500).join('\n')}

README:
${repoData.readme.substring(0, 2000)}

Dependencies:
${repoData.dependencies.substring(0, 2000)}
${repoData.sourceFiles && repoData.sourceFiles.length > 0 ? `\nKey Source Files:\n${repoData.sourceFiles.map(f => `--- ${f.path} ---\n${f.content.substring(0, 2000)}\n`).join('\n')}` : ''}
${additionalContext ? `\nAdditional Context / Future Development Directions:\n${additionalContext}\n` : ''}${analyzeIssues ? `\nCRITICAL INSTRUCTION: Perform a preliminary analysis of the provided repository data. Identify any obvious errors, bugs, architectural inconsistencies, or critically outdated dependencies. Include these findings directly in the generated system prompt.\n` : ''}
Generate a system prompt that includes:
1. The project's purpose and tech stack.
2. The architectural patterns and conventions used.
3. Instructions for the AI on how to assist with this specific codebase.
4. Any specific rules or guidelines for contributing to this project.
${additionalContext ? `5. Specific instructions or considerations based on the provided "Additional Context / Future Development Directions".\n` : ''}${analyzeIssues ? `${additionalContext ? '6' : '5'}. A "Current Issues & Technical Debt" section detailing your analysis of bugs, inconsistencies, and outdated dependencies.` : ''}
`;

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
