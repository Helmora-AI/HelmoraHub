import fs from 'node:fs';
import path from 'node:path';

const dir = 'e:/CtrLAI/research/9router-master/open-sse/providers/registry';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js');
const out = [];

for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const id = (text.match(/id:\s*["']([^"']+)["']/) || [])[1] || f.replace(/\.js$/, '');
  const name = (text.match(/name:\s*["']([^"']+)["']/) || [])[1] || id;
  const category = (text.match(/category:\s*["']([^"']+)["']/) || [])[1] || 'apikey';
  const baseFull = (text.match(/baseUrl:\s*["']([^"']+)["']/) || [])[1] || null;
  const kindsMatch = text.match(/serviceKinds:\s*\[([^\]]*)\]/);
  const kinds = kindsMatch
    ? kindsMatch[1]
        .split(',')
        .map((s) => s.replace(/["'\s]/g, ''))
        .filter(Boolean)
    : [];
  const firstModel = (text.match(/models:\s*\[\s*\{\s*id:\s*["']([^"']+)["']/) || [])[1] || null;
  const format = (text.match(/format:\s*["']([^"']+)["']/) || [])[1] || null;
  const hasOauth = /oauth:\s*\{/.test(text);
  const hidden = /hidden:\s*true/.test(text);
  const noAuth = /noAuth:\s*true/.test(text);
  out.push({
    id,
    name,
    category,
    baseUrl: baseFull,
    kinds,
    defaultModel: firstModel,
    format,
    hasOauth,
    hidden,
    noAuth,
    file: f,
  });
}

const dest = 'e:/CtrLAI/CtrLHub/scripts/_9router-extract.json';
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('wrote', dest, 'count', out.length);
