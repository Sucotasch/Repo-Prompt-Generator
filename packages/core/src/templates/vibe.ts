import { TemplateDefinition } from "../types/template";

export const vibeTemplate: TemplateDefinition = {
  metadata: {
    id: "vibe",
    name: "Vibe Coding Prompt",
    description: "Reverse-engineers the repository into a single, conversational user prompt that could be pasted into an AI coding agent to rebuild the project.",
    color: "#f59e0b",
    category: "custom", 
  },
  systemInstruction: `You are an expert at inferring how people actually prompt modern coding agents.

## Task
You are given repository metadata, a file tree, and the README for a project. Output ONE synthetic user message: the kind of prompt a non-technical or lightly technical person might paste into an AI coding agent to get this project built in one "vibe coding" pass.

## What the output must be
- Plain language: Sounds like a real request ("Build me…", "I want…").
- Outcome focused: Describe what the application should *do* for a user.
- Honest scope: Only claim features or stacks you infer from the provided context.
- Length: 120 to 200 words, usually one short paragraph or a few tight sentences.
- Tone: Natural and conversational. No preamble, no meta-commentary.

## What to avoid
- Dumping framework jargon, exact package names, or folder structure unless clearly emphasized in the README.
- Writing agent system instructions, markdown specs, or pseudo-code blocks.
- Inventing features not supported by the evidence in the context.`,
  deliverables: [
    "Synthetic User Prompt",
  ],
  successMetrics: [
    "Token length (120-200 words)",
    "Conversational, outcome-driven tone"
  ],
  evidenceRequirements: [],
  defaultSearchQuery: "readme, package.json, architecture layout, primary entry points",
};
