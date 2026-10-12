// scripts/vendor-audit.mjs — supply-chain audit (SPEC §10 S16, WP-D acceptance 10).
// 1. Pins: every dependency in package.json is an exact version and the installed copy has that version.
// 2. Graph: walks the browser ESM import graph INDEPENDENTLY of src/server/http/static.ts (own tokenizer: comments,
//    strings, template and regex literals), resolving bare specifiers through the served import map.
// 3. Drift: the static allow-list (buildStatic) must serve exactly the vendor files the graph reaches, every reached /app
//    module must be served, every bare specifier must be in the import map, and no .ts / .d.ts / map file is served.
// Exit 0 when clean, 1 on any drift (each problem printed).
import fs from 'node:fs';
import path from 'node:path';
import { buildStatic, HLJS_LANGS } from '../src/server/http/static.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'src', 'web');
const NM = path.join(ROOT, 'node_modules');
const problems = [];
const bad = (m) => problems.push(m);

// ---------------------------------------------------------------- 1. exact pins
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const [group, deps] of [['dependencies', pkg.dependencies ?? {}], ['devDependencies', pkg.devDependencies ?? {}]]) {
  for (const [name, want] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+$/.test(want)) { bad(`pin: ${group} ${name}@${want} is not an exact version`); continue; }
    let got = null;
    try { got = JSON.parse(fs.readFileSync(path.join(NM, ...name.split('/'), 'package.json'), 'utf8')).version; } catch { /* missing */ }
    if (got === null) { if (group === 'dependencies') bad(`pin: ${name} is not installed`); continue; }
    if (got !== want) bad(`pin: ${name} installed ${got}, package.json pins ${want}`);
  }
}

// ---------------------------------------------------------------- 2. tokenizer + independent graph walk
const MARK = '\u0001';
/** Comments dropped, regex literals blanked, each string / template literal replaced by "<MARK><n>" (text kept in lits). */
export function scan(src) {
  const lits = [];
  let out = '';
  let last = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1, depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (c === '`' && d === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (c === '`' && depth > 0 && d === '}') { depth--; j++; continue; }
        if (d === c && depth === 0) break;
        if (c !== '`' && d === '\n') break;
        j++;
      }
      lits.push(src.slice(i + 1, j));
      out += c + MARK + (lits.length - 1) + c;
      i = j; last = c; continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break;
        j++;
      }
      i = j;
      while (/[a-z]/i.test(src[i + 1] ?? '')) i++;
      out += ' 0 '; last = '0'; continue;
    }
    if (!/\s/.test(c)) last = c;
    out += c;
  }
  return { code: out, lits };
}
const LIT = `(['"])${MARK}(\\d+)\\1`;
const STATIC_RE = new RegExp(`(?<![.\\w$])(?:import|export)\\s*(?:[\\w*{}\\s,$]*?\\s*from\\s*)?${LIT}`, 'g');
const DYNAMIC_RE = new RegExp(`(?<![.\\w$])import\\s*\\(\\s*${LIT}\\s*\\)`, 'g');
const TEMPLATE_RE = new RegExp(`(?<![.\\w$])import\\s*\\(\\s*\`${MARK}(\\d+)\``, 'g');

const served = buildStatic({ webRoot: WEB, nodeModules: NM, assetsDir: path.join(ROOT, 'assets') });
const imports = JSON.parse(served.importMap).imports;
const urlToFile = (u) => (u.startsWith('/app/') ? path.join(WEB, ...u.slice(5).split('/')) : u.startsWith('/vendor/') ? path.join(NM, ...u.slice(8).split('/')) : null);
function resolveBare(spec) {
  if (Object.hasOwn(imports, spec)) return imports[spec];
  const prefix = Object.keys(imports).filter((k) => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return prefix ? imports[prefix] + spec.slice(prefix.length) : null;
}
const reached = new Set();
const queue = [];
const visit = (u, from) => {
  if (reached.has(u)) return;
  const f = urlToFile(u);
  if (!f || !fs.existsSync(f)) { bad(`graph: ${u} (from ${from}) does not exist`); return; }
  reached.add(u); queue.push(u);
};
for (const f of fs.readdirSync(WEB, { recursive: true })) if (/\.js$/i.test(f)) visit('/app/' + f.split(path.sep).join('/'), 'app');
for (const [k, u] of Object.entries(imports)) if (!k.endsWith('/')) visit(u, `import map "${k}"`);
while (queue.length) {
  const u = queue.shift();
  if (!/\.m?js$/i.test(u)) continue;
  const { code, lits } = scan(fs.readFileSync(urlToFile(u), 'utf8'));
  const specs = [...code.matchAll(STATIC_RE), ...code.matchAll(DYNAMIC_RE)].map((m) => lits[Number(m[2])]);
  for (const m of code.matchAll(TEMPLATE_RE)) {
    const t = lits[Number(m[1])];
    if (!t.includes('${')) specs.push(t);
    else if (t.startsWith('hljs/lang/${')) specs.push(...HLJS_LANGS.map((l) => `hljs/lang/${l}.min.js`));
    else bad(`graph: unresolvable template import \`${t}\` in ${u}`);
  }
  for (const s of specs) {
    if (/^(?:https?:|data:|node:|file:)/i.test(s)) { bad(`graph: forbidden specifier ${s} in ${u}`); continue; }
    if (s.startsWith('.') || s.startsWith('/')) { visit(new URL(s, 'http://x' + u).pathname, u); continue; }
    const r = resolveBare(s);
    if (!r) bad(`graph: bare specifier "${s}" in ${u} is not in the import map`);
    else visit(r, u);
  }
}

// ---------------------------------------------------------------- 3. compare with the served allow-list
const servedKeys = new Set(served.files.keys());
const vendorReached = [...reached].filter((k) => k.startsWith('/vendor/'));
for (const k of vendorReached) if (!servedKeys.has(k)) bad(`drift: reached but not served: ${k}`);
for (const k of servedKeys) if (k.startsWith('/vendor/') && !reached.has(k)) bad(`drift: served but not reached: ${k}`);
for (const k of reached) if (k.startsWith('/app/') && !servedKeys.has(k)) bad(`drift: app module not served: ${k}`);
for (const k of servedKeys) if (/\.(?:ts|map)$/i.test(k) || k === '/app/index.html') bad(`served: forbidden file ${k}`);

if (problems.length) {
  for (const p of problems) console.error(`vendor-audit: ${p}`);
  console.error(`vendor-audit: FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''})`);
  process.exit(1);
}
console.log(`vendor-audit: OK — ${vendorReached.length} vendor files, ${reached.size - vendorReached.length} app modules, ${Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length} exact pins`);
