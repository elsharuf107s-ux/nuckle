#!/usr/bin/env node
// Lint for src/gen (design 3.0 rules 1 to 3): every `.sort(` uses a comparator from order.js; no banned Math
// function (only floor, imul, abs, min, max, sqrt, trunc and the constants are allowed: no sin, cos, atan2,
// exp, pow, log, random, round, hypot, cbrt, fround...); no Math.random, Date, performance, DOM or G; no `**`.
//
//   node tools/gen_tests/lint.mjs            exits 1 on any finding
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'src', 'gen');
const ALLOWED_MATH = new Set(['floor', 'imul', 'abs', 'min', 'max', 'sqrt', 'trunc', 'SQRT2']);
const RUNTIME = new Set(['worker.js', 'client.js']);
const COMPARATORS = new Set(['cmpNum', 'cmpStr', 'byScoreThenId']);
const BANNED = [
  [/\bDate\b/, 'Date'], [/\bperformance\b/, 'performance'], [/\bdocument\b|\bwindow\b|\blocalStorage\b/, 'DOM'],
  [/\bG\./, 'the game state G'], [/\*\*/, 'the ** operator (pow)'], [/\bMath\.random\b/, 'Math.random'],
];

// strip comments and string contents so prose never trips the lint
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

export function lint(dir = DIR) {
  const findings = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const lines = code(readFileSync(path.join(dir, f), 'utf8')).split('\n');
    lines.forEach((ln, i) => {
      const at = `${f}:${i + 1}`;
      for (const m of ln.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)) if (!ALLOWED_MATH.has(m[1])) findings.push(`${at} Math.${m[1]} is banned`);
      for (const m of ln.matchAll(/\.sort\(\s*([^)]*)\)/g)) {
        const arg = m[1].trim();
        // order.js sortedNums sorts a Float64Array with its own (specified, numeric) order: allowed there only
        const ok = COMPARATORS.has(arg) || /^byNum\(/.test(arg) || (f === 'order.js' && arg === '' && /\ba\.sort\(\)/.test(ln));
        if (!ok) findings.push(`${at} .sort(${arg}) does not use an order.js comparator`);
      }
      for (const m of ln.matchAll(/\.sort\(\s*$/g)) findings.push(`${at} .sort( split over lines`);
      for (const m of ln.matchAll(/\.toSorted\(|\.localeCompare\(/g)) findings.push(`${at} ${m[0]} is not allowed`);
      // worker.js and client.js are the runtime around the generator (stage 4a): they may time work and talk to the
      // page; the rules for Math and sorting still hold there
      for (const [re, name] of BANNED) if (re.test(ln) && !(RUNTIME.has(f) && name !== 'Math.random' && name !== 'the ** operator (pow)')) findings.push(`${at} ${name} is not allowed`);
    });
  }
  return { files: files.length, findings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { files, findings } = lint();
  // negative control: the lint must catch what it bans
  const probe = code("x.sort(); y.sort((a, b) => a - b); Math.sin(1); Math.pow(2, 3); Math.round(1); Date.now(); 2 ** 3; z.sort(cmpNum); Math.floor(1);");
  const bad = [];
  for (const m of probe.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)) if (!ALLOWED_MATH.has(m[1])) bad.push(m[1]);
  for (const m of probe.matchAll(/\.sort\(\s*([^)]*)\)/g)) if (!COMPARATORS.has(m[1].trim())) bad.push('sort ' + m[1]);
  for (const [re, name] of BANNED) if (re.test(probe)) bad.push(name);
  const controlOk = bad.length === 7;
  for (const f of findings) console.log('LINT', f);
  console.log(`lint: ${files} files in src/gen, ${findings.length} findings; negative control ${controlOk ? 'caught all 7' : 'FAILED: ' + bad.join(',')}`);
  process.exit(findings.length || !controlOk ? 1 : 0);
}
