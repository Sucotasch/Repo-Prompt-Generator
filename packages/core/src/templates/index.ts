import { TemplateDefinition } from "../types/template";
import { defaultTemplate } from "./default";
import { auditTemplate } from "./audit";
import { securityTemplate } from "./security";
import { docsTemplate } from "./docs";
import { integrationTemplate } from "./integration";
import { eli5Template } from "./eli5";

export const templates: Record<string, TemplateDefinition> = {
  default: defaultTemplate,
  audit: auditTemplate,
  security: securityTemplate,
  docs: docsTemplate,
  integration: integrationTemplate,
  eli5: eli5Template,
};

export function getTemplate(id: string): TemplateDefinition | undefined {
  return templates[id];
}

export function getAllTemplates(): TemplateDefinition[] {
  return Object.values(templates);
}

export function getTemplateMetadata(id: string) {
  return templates[id]?.metadata;
}
