import { TemplateDefinition } from "../types/template.ts";

export const tutorialTemplate: TemplateDefinition = {
  metadata: {
    id: "tutorial",
    name: "Codebase Knowledge Tutorial",
    description: "Generates a beginner-friendly tutorial with architectural Mermaid diagrams.",
    color: "#fbbf24", // A distinct yellow color for the UI
    category: "tutorial",
  },
  systemInstruction: `You are an expert technical educator and software architect. Your task is to analyze the provided codebase context and generate a beginner-friendly, structured tutorial in Markdown format.

REQUIRED OUTPUT STRUCTURE:
1. **Frontmatter**: Include Jekyll-style YAML frontmatter (layout: default, title: "<Project Name>").
2. **Title & Notice**: Use a H1 title starting with "Tutorial: ". Follow it with a blockquote stating the tutorial is AI-generated.
3. **Overview**: Write a 1-paragraph beginner-friendly explanation of what the codebase does, highlighting core abstractions. Use bold and italic text for emphasis.
4. **Architecture Diagram**: Create a Mermaid.js 'flowchart TD' block mapping out the core abstractions, classes, or modules. 
   - Define nodes clearly (e.g., A0["Component Name"]).
   - Label the relationship edges with verbs (e.g., A0 -- "Manages" --> A1).
5. **Component Breakdown**: Briefly explain each component shown in the diagram.
6. **Chapter Outline**: Suggest 3-5 logical chapters for a deeper dive into the codebase.

CRITICAL RULES:
- Base all components, relationships, and code references STRICTLY on the provided repository context. 
- Ensure the tone is accessible, similar to an "Explain Like I'm 5" (ELI5) approach, but technically accurate.`,
  deliverables: [
    "YAML Frontmatter",
    "Beginner-friendly Overview",
    "Mermaid Flowchart Diagram (TD)",
    "Suggested Chapter Outline"
  ],
  successMetrics: ["Beginner friendly tone", "Diagram relationship accuracy", "Markdown structure compliance"],
  evidenceRequirements: [],
  defaultSearchQuery:
    "core abstractions, main classes, entry points, module interactions, architecture, data flow",
};
