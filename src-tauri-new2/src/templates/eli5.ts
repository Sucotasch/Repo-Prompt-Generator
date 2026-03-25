import { TemplateDefinition } from '../types/template';

export const eli5Template: TemplateDefinition = {
  metadata: {
    id: 'eli5',
    name: 'Explain Like I\'m 5 (ELI5)',
    description: 'Explain the codebase in simple, fun terms',
    color: '#fcd34d',
    category: 'eli5',
  },
  systemInstruction: `Explain what this repository does as if I am a 5-year-old child, but focus heavily on safety. 

Tell me in very simple, funny, and exaggerated (but accurate) terms:
1. What does this code actually do? (e.g., "It draws pictures of cats" or "It's a boring calculator").
2. Is it safe to run? 
3. If it's dangerous, warn me dramatically! (e.g., "Don't even think about running this! It's a malicious joke that will encrypt your C: drive!").
4. If it's just old or broken, tell me (e.g., "Nothing scary will happen, but it probably won't even run because the code is older than your grandma. You can look at it to learn, but don't try to make it work for you.").

Keep the tone light, entertaining, and extremely easy to understand, but ensure the safety assessment is completely accurate based on the code provided.`,
  deliverables: [],
  successMetrics: [],
  evidenceRequirements: [],
  defaultSearchQuery: 'core functionality, main purpose, basic structure, simple logic',
};
