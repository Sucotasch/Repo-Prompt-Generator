import { TemplateDefinition } from "../types/template";

export const defaultTemplate: TemplateDefinition = {
  metadata: {
    id: "default",
    name: "Default System Prompt",
    description: "General purpose system prompt for codebase analysis",
    color: "#94a3b8",
    category: "default",
  },
  systemInstruction: `You are an expert software engineer and AI assistant. Based on the following GitHub repository information, generate a comprehensive system prompt suitable for further development of the project using Gemini CLI or Antigravity. The prompt should be formatted as markdown, ready to be saved as \`gemini.md\`.

Generate a system prompt that includes:
1. The project's purpose and tech stack.
2. The architectural patterns and conventions used.
3. Instructions for the AI on how to assist with this specific codebase.
4. Any specific rules or guidelines for contributing to this project.`,
  deliverables: [],
  successMetrics: [],
  evidenceRequirements: [],
  defaultSearchQuery:
    "core logic, architecture, main components, tech stack, dependencies",
};
