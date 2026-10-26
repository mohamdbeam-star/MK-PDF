// Copies runtime assets from dependencies into public/ so the app works fully offline.
import fs from 'node:fs';
import path from 'node:path';

const copyDir = (from, to, filter = () => true) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) if (filter(f)) fs.copyFileSync(path.join(from, f), path.join(to, f));
};
copyDir('node_modules/pdfjs-dist/cmaps', 'public/cmaps');
copyDir('node_modules/pdfjs-dist/standard_fonts', 'public/standard_fonts');
copyDir('node_modules/tesseract.js/dist', 'public/tesseract', (f) => f === 'worker.min.js');
copyDir('node_modules/tesseract.js-core', 'public/tesseract', (f) => /-lstm\.(js|wasm|wasm\.js)$/.test(f));
console.log('assets copied');
