// node: npx tsx scripts/export.mts in.pdf out.docx [page]  — converts with the shared core (JPEG pictures only).
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { convertLayouts, layoutsFor, type DocFormat } from '../src/core/convert';
import { pageTextItems } from '../src/engine/textItems';
import { PageContent, type GraphicObject } from '../src/engine/pageContent';

const [input, output, pageArg] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(input));
const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
const { doc, pages } = await layoutsFor(bytes, (i) => pageTextItems(js as never, i + 1), pageArg ? [Number(pageArg) - 1] : undefined);
const out = await convertLayouts(pages, output.split('.').pop() as DocFormat, input, {
  async image(page, item) {
    const obj = (item as { object?: GraphicObject }).object;
    const info = obj ? new PageContent(doc, doc.getPage(page)).imageStream(obj) : null;
    return info?.jpeg ? { data: info.stream.getContents(), ext: 'jpeg' } : null;
  },
  background: async () => null,
});
fs.writeFileSync(output, out);
console.log(output, out.length);
