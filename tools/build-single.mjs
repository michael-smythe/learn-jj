// Assembles a single self-contained HTML file (for hosting as an artifact or
// emailing around). Output has no <html>/<head>/<body> wrapper — the host page
// provides those — just <title> + <style> + markup + inline <script>s.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

const css = read('style.css');
const html = read('index.html');
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*><\/script>\s*/g, '');

const js = ['js/compare.js', 'js/engine.js', 'js/graph.js', 'js/levels.js', 'js/main.js'].map(read).join('\n');

const out = `<meta charset="utf-8">
<title>Learn jj — an interactive Jujutsu tutorial</title>
<style>
${css}
/* host-page embedding: the app owns the viewport */
html, body { height: 100%; margin: 0; padding: 0; }
</style>
${body}
<script>
${js}
</script>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/learn-jj.html'), out);
console.log('wrote dist/learn-jj.html (' + out.length + ' bytes)');
