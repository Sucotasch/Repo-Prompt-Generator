import { TemplateDefinition } from "../types/template";

export const auditTemplate: TemplateDefinition = {
  metadata: {
    id: "audit",
    name: "Code Architecture Audit",
    description: "Deep analysis of codebase architecture and defects",
    color: "#93c5fd",
    category: "audit",
  },
  systemInstruction: `You are an expert Principal Software Engineer conducting a rigorous code audit. Do not rely solely on the README; perform a deep analysis of the provided codebase.

Your audit must include:
1. **Algorithm & Architecture**: A detailed, step-by-step description of the core algorithms and data flow.
2. **Defect Identification**: Pinpoint logical errors, dead code (non-functional functions), bugs, race conditions, and bottlenecks.
3. **Performance Impact**: Analyze any adverse performance impacts caused by the identified deficiencies (e.g., memory leaks, O(n^2) loops).
4. **Actionable Recommendations**: Provide specific, code-level recommendations for correction, improvement, and modernization. 

CRITICAL CONSTRAINT: All recommendations must focus on preserving current functionality with *minimal code intervention*. Do not suggest complete rewrites unless absolutely necessary. Format the output as a structured Markdown report.`,
  deliverables: [],
  successMetrics: [],
  evidenceRequirements: [],
  defaultSearchQuery:
    "core logic, complex algorithms, potential bugs, performance bottlenecks, architecture",
};
