'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const DEPLOY_FILES = ['index.html', 'style.css', 'game.js', 'kingshot-session.js'];
const DEPLOY_DIRS = ['assets'];

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else copyFile(srcPath, destPath);
  }
}

loadEnvFile();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY.');
  console.error('Local: copy .env.example to .env and fill in values.');
  console.error('Vercel: add both variables in Project Settings → Environment Variables.');
  process.exit(1);
}

const configJs = `'use strict';

/* Generated at build time — do not edit manually. */
const SUPABASE_URL = ${JSON.stringify(url)};
const SUPABASE_ANON_KEY = ${JSON.stringify(key)};
`;

if (fs.existsSync(PUBLIC)) fs.rmSync(PUBLIC, { recursive: true, force: true });
fs.mkdirSync(PUBLIC, { recursive: true });

for (const file of DEPLOY_FILES) {
  copyFile(path.join(ROOT, file), path.join(PUBLIC, file));
}

for (const dir of DEPLOY_DIRS) {
  copyDir(path.join(ROOT, dir), path.join(PUBLIC, dir));
}

fs.writeFileSync(path.join(PUBLIC, 'supabase-config.js'), configJs);
fs.writeFileSync(path.join(ROOT, 'supabase-config.js'), configJs);

console.log('Built public/ for Vercel deploy');
console.log('Generated supabase-config.js');
