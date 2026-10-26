// For each PDF: how much pdf.js-visible text the content engine can reach directly on the page.
import fs from 'node:fs';
import path from 'node:path';
import { loadPdf } from '../src/engine/load';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PageContent } from '../src/engine/pageContent';
import { layoutPage } from '../src/engine/layout';
import { pageTextItems } from '../src/engine/textItems';

const dir = process.argv[2];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pdf'))) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const lib = await loadPdf(bytes);
  const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  let total = 0, hit = 0, inBlock = 0, forms = 0, widgets = 0, annotsText = 0;
  const pages = lib.getPageCount();
  const missed: string[] = [];
  for (let p = 0; p < pages; p++) {
    const pc = new PageContent(lib, lib.getPage(p));
    const glyphs = pc.shows.flatMap((s) => s.glyphs).filter((g) => !g.invisible);
    forms += pc.objects.filter((o) => o.kind === 'form').length;
    const lay = layoutPage(lib, p, await pageTextItems(js as never, p + 1), pc);
    const boxes = lay.items.flatMap((i) => i.kind === 'paragraph' ? [i.rect] : i.kind === 'table' ? i.rows.flat().filter(Boolean).map((c) => c!.rect) : []);
    const page = await js.getPage(p + 1);
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      if (!it.str?.trim()) continue;
      const n = it.str.replace(/\s/g, '').length;
      total += n;
      const x = it.transform[4] + it.width / 2, y = it.transform[5] + Math.abs(it.transform[3]) * 0.3;
      if (boxes.some((b) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2)) inBlock += n; else if (missed.length < 6) missed.push(`p${p + 1}:${it.str.slice(0, 30)}`);
      if (glyphs.some((g) => x >= g.rect.x - 2 && x <= g.rect.x + g.rect.w + 2 && y >= g.rect.y - 2 && y <= g.rect.y + g.rect.h + 2)) hit += n;
    }
    for (const a of await page.getAnnotations()) { if (a.subtype === 'Widget') widgets++; else if (a.subtype === 'FreeText') annotsText++; }
  }
  console.log(`blocks ${(total ? Math.round((inBlock / total) * 100) : 100).toString().padStart(3)}% glyphs ${(total ? Math.round((hit / total) * 100) : 100).toString().padStart(3)}%  chars=${total} formXObj=${forms} widgets=${widgets} freetext=${annotsText}  ${f}${missed.length ? '\n      missed: ' + missed.join(' | ') : ''}`);
}
