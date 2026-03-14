import { TemplateDefinition } from '../types/template';

export const docsTemplate: TemplateDefinition = {
  metadata: {
    id: 'docs',
    name: 'Technical Documentation Generator',
    description: 'Create comprehensive technical documentation',
    color: '#6ee7b7',
    category: 'docs',
  },
  systemInstruction: `You are an expert technical writer and software architect. Analyze the provided GitHub repository data to create comprehensive technical documentation in Markdown format (suitable for a Wiki or a detailed README.md). Make the code understandable.

Include:
1. Real capabilities of the program.
2. Algorithm of operation and architecture.
3. Installation and configuration process.
4. Examples of using the main functions.

RECOMMENDATION: When explaining architecture or data flows, feel free to use Mermaid.js diagrams (e.g., \`\`\`mermaid graph TD...\`\`\`) to make it more visual. Always support your explanations with actual file paths and code snippets from the provided context.`,
  deliverables: [],
  successMetrics: [],
  evidenceRequirements: [],
  defaultSearchQuery: 'main entry points, exported functions, public API, core architecture, high-level modules',
};
