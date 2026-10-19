// Run the unmodified upstream functional smoke test using installed Chromium.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'assets/world.json'))) {
  console.error('Game assets are missing. Run: bash scripts/setup-dev.sh');
  process.exit(1);
}
const executable = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
if (!executable) {
  console.error('Install Chromium or set CHROMIUM_PATH to its executable.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const playwright = require.resolve('playwright');
const output = path.join(root, 'out/smoke');
mkdirSync(output, { recursive: true });
const adapter = path.join(output, 'playwright-adapter.cjs');
writeFileSync(adapter, `const pw = require(${JSON.stringify(playwright)});
module.exports = { chromium: { launch: (options) => {
  const { channel, ...rest } = options;
  return pw.chromium.launch({ ...rest, executablePath: ${JSON.stringify(executable)} });
} } };\n`);
const result = spawnSync(process.execPath, ['tools/headless.mjs', 'tools/smoke.mjs', '--params', '?new', '--out', 'out/smoke'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_DIR: adapter }
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
