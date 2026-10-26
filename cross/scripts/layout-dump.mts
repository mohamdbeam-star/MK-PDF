// Prints the layout model of a page (paragraphs and tables) for checking exports.
import fs from 'node:fs';
import { loadPdf } from '../src/engine/load';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPage, lineText, paragraphText } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';
const [file, pageArg] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(file));
const lib = await loadPdf(bytes);
const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
const p = Number(pageArg ?? 1) - 1;
const lay = layoutPage(lib, p, await pageTextItems(js as never, p + 1));
for (const it of lay.items) {
  if (it.kind === 'paragraph') console.log(`P[${it.alignment}${it.rtl ? ',rtl' : ''}] ${JSON.stringify(paragraphText(it)).slice(0, 110)}`);
  else if (it.kind === 'image') console.log(`IMG ${it.rect.w.toFixed(0)}x${it.rect.h.toFixed(0)}`);
  else {
    console.log(`TABLE ${it.ruled ? 'ruled' : 'inferred'} ${it.colEdges.length - 1} cols × ${it.rowRects.length} rows, ${it.cells.length} cells`);
    for (const c of it.cells.slice(0, 40)) console.log(`   r${c.row}c${c.col}${c.colSpan > 1 ? ` cs${c.colSpan}` : ''}${c.rowSpan > 1 ? ` rs${c.rowSpan}` : ''} [${c.alignment},${c.valign}]${c.fill ? ' fill' : ''} ${JSON.stringify(c.lines.map(lineText).join(' / ')).slice(0, 80)}`);
  }
}
for (const b of lay.boxes) console.log(`BOX${b.figure ? '(figure)' : ''} ${b.rect.x.toFixed(0)},${b.rect.y.toFixed(0)} ${b.rect.w.toFixed(0)}x${b.rect.h.toFixed(0)} fill=${b.fill?.map((c) => c.toFixed(2))} ${(['top', 'right', 'bottom', 'left'] as const).map((k) => b.borders[k] ? `${k}:${b.borders[k]!.width.toFixed(1)}@${b.borders[k]!.color.map((c) => c.toFixed(2))}` : '').filter(Boolean).join(' ')}`);
for (const c of lay.columns) console.log(`COLUMNS band y=${c.rect.y.toFixed(0)}..${(c.rect.y + c.rect.h).toFixed(0)} cols ${c.cols.map((r) => `${r.x.toFixed(0)}-${(r.x + r.w).toFixed(0)}`).join(' | ')}`);
