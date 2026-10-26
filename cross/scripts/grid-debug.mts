// Prints the grid edges and nearby drawing for a page (debug aid for table detection).
import fs from 'node:fs';
import { loadPdf } from '../src/engine/load';
import { PageContent, rect } from '../src/engine/pageContent';
import { findGrids } from '../src/engine/tables';

const [file, pageArg, y0, y1] = process.argv.slice(2);
const lib = await loadPdf(new Uint8Array(fs.readFileSync(file)));
const page = lib.getPage(Number(pageArg) - 1);
const pc = new PageContent(lib, page);
const m = page.getCropBox();
const f1 = (n: number) => n.toFixed(1);
for (const g of findGrids(pc.rules, pc.ruleColors, pc.fills, rect(m.x, m.y, m.width, m.height))) {
  console.log('cols', g.colEdges.map(f1).join(' '));
  console.log('rows', g.rowEdges.map(f1).join(' '));
}
const lo = Number(y0 ?? 0), hi = Number(y1 ?? 0);
if (hi) {
  console.log('rules', pc.rules.filter((r) => r.y >= lo && r.y <= hi).map((r) => `${f1(r.x)},${f1(r.y)} ${f1(r.w)}x${f1(r.h)}`).join(' | '));
  console.log('fills', pc.fills.filter((f) => f.rect.y >= lo - 20 && f.rect.y <= hi).map((f) => `${f1(f.rect.x)},${f1(f.rect.y)} ${f1(f.rect.w)}x${f1(f.rect.h)} ${f.color.map((c) => c.toFixed(2))}`).join(' | '));
}
