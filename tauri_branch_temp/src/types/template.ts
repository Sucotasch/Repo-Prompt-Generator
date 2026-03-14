export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  color: string;
  category: 'audit' | 'security' | 'docs' | 'integration' | 'eli5' | 'custom' | 'default' | 'performance' | 'refactor' | 'architecture';
}

export interface TemplateDefinition {
  metadata: TemplateMetadata;
  systemInstruction: string;
  deliverables: string[];
  successMetrics: string[];
  evidenceRequirements: string[];
  tone?: string;
  constraints?: string[];
  defaultSearchQuery: string;
}
