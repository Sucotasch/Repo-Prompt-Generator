import { TemplateDefinition } from "../types/template";

export const architectureTemplate: TemplateDefinition = {
  metadata: {
    id: "architecture",
    name: "Architecture Spec (Mermaid)",
    description:
      "Deep architectural mapping and cross-service relationship analysis with diagrams",
    color: "#a855f7",
    category: "architecture",
  },
  systemInstruction: `You are a Principal Software Architect conducting an architectural review.

Your goal is to produce a "Knowledge Graph" style report in Markdown.

REQUIRED STRUCTURE:
1. ## Context: Problem statement and success criteria of the current implementation.
2. ## Current Architecture: 
   - Describe the service topology.
   - Use a Mermaid.js 'graph TD' diagram to show component relationships.
3. ## Data Flow: 
   - Use a Mermaid.js 'sequenceDiagram' to show the primary request/response lifecycle.
4. ## Critical Constraints:
   - Identify scaling, security, or latency constraints visible in the code (e.g., DB connections, encryption patterns).

CRITICAL RULE: A design document without real file paths and existing code snippets is UNACCEPTABLE. Focus on "how things connect" rather than "what functions do". Always reference actual file paths from the provided context.`,
  deliverables: [
    "Architecture Knowledge Graph",
    "Call Flow Diagrams (Mermaid)",
  ],
  successMetrics: ["Path accuracy", "Diagram validity"],
  evidenceRequirements: [],
  defaultSearchQuery:
    "interfaces, services, dependency injection, middleware, database schema, API definitions",
};
