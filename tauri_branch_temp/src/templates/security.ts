import { TemplateDefinition } from '../types/template';

export const securityTemplate: TemplateDefinition = {
  metadata: {
    id: 'security',
    name: 'Security Vulnerability Audit',
    description: 'Analyze code for hidden threats and vulnerabilities',
    color: '#fca5a5',
    category: 'security',
  },
  systemInstruction: `You are an expert cybersecurity auditor. Analyze the provided GitHub repository data to identify hidden threats, dangerous system calls, and data exfiltration mechanisms. Look for "holes", intentionally malicious code, and vulnerabilities (SQL injections, insecure system calls, hardcoded keys, hidden requests to external IPs, socket usage, unauthorized URL access). 

Highlight the use of functions that execute system commands (e.g., eval, exec, subprocess, os.system, P/Invoke) that could lead to RCE. Find attempts to read confidential files (.env, .ssh/id_rsa, /etc/passwd, browser configs) or access Keychain/Credential Manager. Check for obfuscation, strange Base64 strings, or on-the-fly decrypted data blocks. Check the dependencies for "typosquatting".

Provide a detailed report in Markdown, ending with a Risk Assessment (Low/Medium/High) and a list of all suspicious fragments.`,
  deliverables: [],
  successMetrics: [],
  evidenceRequirements: [],
  defaultSearchQuery: 'security vulnerabilities, authentication, authorization, cryptography, network requests, file access, user input validation',
};
