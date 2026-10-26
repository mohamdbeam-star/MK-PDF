// Prints a page's drawing summary: images, form objects, rules and fills (debug aid).
import fs from 'node:fs';
import { loadPdf } from '../src/engine/load';
import { PageContent } from '../src/engine/pageContent';
const [file, pageArg] = process.argv.slice(2);
const lib = await loadPdf(new Uint8Array(fs.readFileSync(file)));
const pc = new PageContent(lib, lib.getPage(Number(pageArg ?? 1) - 1));
const r = (x: { x: number; y: number; w: number; h: number }) => `${x.x.toFixed(0)},${x.y.toFixed(0)} ${x.w.toFixed(0)}x${x.h.toFixed(0)}`;
console.log('objects', pc.objects.map((o) => `${o.kind}:${o.name} ${r(o.bounds)}`));
console.log('rules', pc.rules.length, 'h', pc.rules.filter((x) => x.w >= x.h).length, 'v', pc.rules.filter((x) => x.h > x.w).length);
console.log('fills', pc.fills.length, pc.fills.slice(0, 12).map((f) => `${r(f.rect)} ${f.color.map((c) => c.toFixed(2))}`));
console.log('ops', pc.operations.length);
