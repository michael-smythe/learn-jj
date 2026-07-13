// Bumps the ?v=N cache-buster on every asset reference in index.html.
// GitHub Pages (and python http.server) serve with cache headers that can
// hold stale JS — run this whenever js/ or style.css changes ship.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const html = readFileSync(path, 'utf8');
const versions = [...html.matchAll(/\?v=(\d+)/g)].map(m => parseInt(m[1], 10));
if (!versions.length) {
  console.error('No ?v=N markers found in index.html');
  process.exit(1);
}
const next = Math.max(...versions) + 1;
writeFileSync(path, html.replace(/\?v=\d+/g, `?v=${next}`));
console.log(`index.html assets bumped to ?v=${next}`);
