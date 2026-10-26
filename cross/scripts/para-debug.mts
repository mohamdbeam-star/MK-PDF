// Prints each paragraph's lines with positions (debug aid for paragraph grouping and line breaks).
import fs from 'node:fs';
import { loadPdf } from '../src/engine/load';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPage, lineText } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';
const [file, pageArg, filter] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(file));
const lib = await loadPdf(bytes);
const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
const p = Number(pageArg ?? 1) - 1;
for (const it of layoutPage(lib, p, await pageTextItems(js as never, p + 1)).items) {
  if (it.kind !== 'paragraph' || (filter && !it.lines.some((l) => lineText(l).includes(filter)))) continue;
  console.log(`P x=${it.rect.x.toFixed(1)} w=${it.rect.w.toFixed(1)} ${it.alignment}`);
  for (const l of it.lines) console.log(`   base=${l.baseline.toFixed(1)} x=${l.rect.x.toFixed(1)} w=${l.rect.w.toFixed(1)} break=${!!l.hardBreak} ${JSON.stringify(lineText(l))}`);
}
