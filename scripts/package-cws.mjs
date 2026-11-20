#!/usr/bin/env node
/**
 * Builds the Chrome Web Store (production) target, strips dev-only build-meta.json,
 * creates a clean uploadable ZIP at dist/agentCast-v<version>-cws.zip,
 * and validates the manifest against Chrome Web Store requirements.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const distDir = path.join(rootDir, 'dist');
const unpackedDir = path.join(distDir, 'chrome-mv3');
const stageDir = path.join(distDir, 'cws-stage');
const zipPath = path.join(distDir, `agentCast-v${pkg.version}-cws.zip`);

console.log(`[package-cws] Building production target for v${pkg.version}...`);
execFileSync(process.execPath, [path.join(rootDir, 'scripts/build-extension.mjs')], {
  cwd: rootDir,
  env: { ...process.env, BUILD_TARGET: 'production' },
  stdio: 'inherit',
});

// Validate manifest
const manifest = JSON.parse(fs.readFileSync(path.join(unpackedDir, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('manifest_version must be 3');
if (manifest.host_permissions?.includes('<all_urls>')) {
  throw new Error('CWS build must not request <all_urls> in host_permissions');
}
if (manifest.permissions?.includes('activeTab')) {
  throw new Error('CWS tab capture must use opt-in HTTPS host permissions');
}
if (manifest.optional_host_permissions?.length !== 1 ||
    manifest.optional_host_permissions[0] !== 'https://*/*') {
  throw new Error('CWS optional host permissions must be HTTPS-only');
}
if (manifest.web_accessible_resources?.length) {
  throw new Error('CWS build must not expose dev build-meta.json in web_accessible_resources');
}
for (const size of ['16', '32', '48', '128']) {
  const rel = manifest.icons?.[size];
  if (!rel || !fs.existsSync(path.join(unpackedDir, rel))) {
    throw new Error(`Missing required icon ${size}: ${rel}`);
  }
}

// Stage clean copy without build-meta.json
fs.rmSync(stageDir, { recursive: true, force: true });
fs.cpSync(unpackedDir, stageDir, { recursive: true });
fs.rmSync(path.join(stageDir, 'build-meta.json'), { force: true });
fs.rmSync(zipPath, { force: true });

// Zip using python3 zipfile (always available on Linux/macOS without requiring `zip` binary)
execFileSync(
  'python3',
  [
    '-c',
    `import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for base, _, files in os.walk(src):
        for fn in sorted(files):
            full = os.path.join(base, fn)
            zf.write(full, os.path.relpath(full, src))
`,
    stageDir,
    zipPath,
  ],
  { stdio: 'inherit' }
);

const stat = fs.statSync(zipPath);
console.log(
  `[package-cws] Ready: ${path.relative(rootDir, zipPath)} (${(stat.size / 1024).toFixed(1)} KB)`
);
fs.rmSync(stageDir, { recursive: true, force: true });
