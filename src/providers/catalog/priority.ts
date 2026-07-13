/** Ids that receive catalog force-sync on boot (Phase 3.1b). Ids only — no golden fields. */
export const PRIORITY_PROVIDER_IDS = new Set<string>([
  'ollama',
  'groq',
  'openrouter',
  'modelscope',
  'llm7',
  'kiraai',
  'cerebras',
  'mistral',
  'aimlapi',
  'nvidia',
  'gemini',
  'cloudflare',
  'glm-cn',
  'zhipu',
]);

export function isPriorityProviderId(id: string): boolean {
  return PRIORITY_PROVIDER_IDS.has(id);
}
