// Копирует статическое приложение в mobile/www для сборки APK.
// Кроссплатформенная замена sync-web.ps1 (нужна в CI на Linux).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const dst = path.join(here, 'www');

const EXCLUDE_DIRS = new Set(['mobile', 'scripts', 'supabase', 'tools', 'shots', '.git', 'node_modules', 'android', '.github']);
const EXCLUDE_FILES = new Set(['.gitignore', '.nojekyll']);

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });

let copied = 0;
function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), relPath);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      const to = path.join(dst, relPath);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(dir, entry.name), to);
      copied += 1;
    }
  }
}

walk(src);
console.log(`web assets: ${copied} файлов → ${dst}`);
