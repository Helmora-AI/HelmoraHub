import fs from 'node:fs';

const path = new URL('../src/providers/catalog/nine-router.ts', import.meta.url);
let text = fs.readFileSync(path, 'utf8');

// Mark Anthropic Messages API providers as ready (P2 adapter).
text = text.replace(
  /("protocol":"anthropic"[^}]*?"catalogReady":)false/g,
  '$1true'
);

// Fix Google AI Studio Gemini (API key) — was misclassified as oauth.
text = text.replace(
  /\{"id":"gemini","label":"Gemini","tier":3,"protocol":"oauth","authStyle":"oauth","baseUrl":"https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models","defaultModel":"gemini-3\.1-pro-preview","capabilities":\["streaming","tools","vision"\],"source":"9router","catalogReady":false\}/,
  '{"id":"gemini","label":"Gemini","tier":3,"protocol":"gemini","authStyle":"query-key","baseUrl":"https://generativelanguage.googleapis.com/v1beta","defaultModel":"gemini-2.5-flash","capabilities":["streaming","tools","vision"],"source":"9router","catalogReady":true}'
);

fs.writeFileSync(path, text);
const readyA = (text.match(/"protocol":"anthropic"[^\n]+"catalogReady":true/g) || []).length;
const readyG = (text.match(/"id":"gemini"[^\n]+"catalogReady":true/g) || []).length;
console.log({ anthropicReady: readyA, geminiReady: readyG });
