/**
 * One-shot generator: 9Router registry extract → TypeScript catalog stubs/ready rows.
 * Run: node scripts/generate-9router-catalog.mjs
 */
import fs from 'node:fs';

const extract = JSON.parse(
  fs.readFileSync(new URL('./_9router-extract.json', import.meta.url), 'utf8')
);

/** FreeLLMAPI ids — prefer FreeLLM row when merging; 9Router still contributes unique ids. */
const FREELLM_IDS = new Set([
  'google',
  'groq',
  'cerebras',
  'nvidia',
  'mistral',
  'openrouter',
  'github',
  'cohere',
  'cloudflare',
  'zhipu',
  'ollama',
  'kilo',
  'pollinations',
  'llm7',
  'huggingface',
  'opencode',
  'ovh',
  'agnes',
  'reka',
  'siliconflow',
  'routeway',
  'bazaarlink',
  'ainative',
  'aion',
  'requesty',
  'nara',
  'aihorde',
]);

function openaiRoot(baseUrl) {
  if (!baseUrl) return null;
  let u = baseUrl.replace(/\/$/, '');
  if (u.endsWith('/chat/completions')) u = u.slice(0, -'/chat/completions'.length);
  if (u.endsWith('/messages')) u = u.slice(0, -'/messages'.length);
  return u || null;
}

function classify(row) {
  const kinds = row.kinds || [];
  const hasLlm = kinds.includes('llm') || kinds.length === 0;
  const mediaOnly =
    !hasLlm &&
    kinds.some((k) =>
      ['embedding', 'image', 'tts', 'stt', 'webSearch', 'webFetch', 'video', 'music', 'imageToText'].includes(
        k
      )
    );

  if (row.category === 'webCookie') {
    return { protocol: 'cookie', authStyle: 'cookie', catalogReady: false };
  }
  // Google AI Studio (API key) — even if registry also lists OAuth helpers
  if (
    row.id === 'gemini' ||
    ((row.baseUrl || '').includes('generativelanguage.googleapis.com') &&
      row.category !== 'oauth')
  ) {
    const root = openaiRoot(row.baseUrl)?.replace(/\/models$/, '') || row.baseUrl;
    return {
      protocol: 'gemini',
      authStyle: 'query-key',
      catalogReady: true,
      baseUrl: root,
    };
  }
  if (row.hasOauth || row.category === 'oauth') {
    return { protocol: 'oauth', authStyle: 'oauth', catalogReady: false };
  }
  if (mediaOnly) {
    return { protocol: 'media', authStyle: row.noAuth ? 'none' : 'bearer', catalogReady: false };
  }
  if (row.format === 'claude' || (row.baseUrl || '').includes('anthropic.com') || (row.baseUrl || '').includes('/anthropic/')) {
    return { protocol: 'anthropic', authStyle: 'x-api-key', catalogReady: true };
  }
  if (row.format === 'gemini' || (row.id === 'gemini' && (row.baseUrl || '').includes('generativelanguage'))) {
    return { protocol: 'gemini', authStyle: 'query-key', catalogReady: true, baseUrl: openaiRoot(row.baseUrl)?.replace(/\/models$/, '') || row.baseUrl };
  }
  if (row.format === 'vertex') {
    return { protocol: 'gemini', authStyle: 'query-key', catalogReady: false };
  }
  if (row.format && !['openai', 'openai-responses'].includes(row.format) && row.format !== 'ollama') {
    return { protocol: 'media', authStyle: 'bearer', catalogReady: false };
  }

  const root = openaiRoot(row.baseUrl);
  const looksOpenAI =
    root &&
    (row.baseUrl.includes('/chat/completions') ||
      row.baseUrl.includes('/v1') ||
      row.format === 'openai' ||
      !row.format);

  if (row.noAuth && looksOpenAI) {
    return { protocol: 'keyless', authStyle: 'none', catalogReady: true, baseUrl: root };
  }
  if (looksOpenAI && (row.category === 'apikey' || row.category === 'freeTier' || row.category === 'free')) {
    return { protocol: 'openai', authStyle: 'bearer', catalogReady: true, baseUrl: root };
  }

  return {
    protocol: 'openai',
    authStyle: 'bearer',
    catalogReady: false,
    baseUrl: root,
  };
}

function tierFor(row) {
  if (row.category === 'oauth' || row.category === 'webCookie') return 1;
  if (row.category === 'free' || row.category === 'freeTier') return 3;
  return 2;
}

function caps(row, ready) {
  const c = ['streaming'];
  if ((row.kinds || []).includes('llm')) c.push('tools');
  if ((row.kinds || []).includes('imageToText')) c.push('vision');
  if (!ready) return c;
  return c.length ? c : ['tools', 'streaming'];
}

const lines = [];
lines.push('/** Auto-generated from 9Router registry — do not edit by hand. */');
lines.push("import type { CatalogEntry } from '../types.js';");
lines.push('');
lines.push('export const NINE_ROUTER_CATALOG: CatalogEntry[] = [');

for (const row of extract) {
  if (FREELLM_IDS.has(row.id)) continue; // FreeLLMAPI owns these ids
  const c = classify(row);
  const baseUrl = c.baseUrl !== undefined ? c.baseUrl : openaiRoot(row.baseUrl);
  const entry = {
    id: row.id,
    label: row.name,
    tier: tierFor(row),
    protocol: c.protocol,
    authStyle: c.authStyle,
    baseUrl,
    defaultModel: row.defaultModel,
    capabilities: caps(row, c.catalogReady),
    source: '9router',
    catalogReady: c.catalogReady,
  };
  lines.push('  ' + JSON.stringify(entry) + ',');
}

lines.push('];');
lines.push('');

const dest = new URL('../src/providers/catalog/nine-router.ts', import.meta.url);
fs.writeFileSync(dest, lines.join('\n'));
console.log('wrote', dest.pathname, 'entries', extract.filter((r) => !FREELLM_IDS.has(r.id)).length);
