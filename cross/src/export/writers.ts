// Document writers built from the page layout model. Port of DocumentWriters.swift.
import { strToU8, zipSync } from 'fflate';
import {
  LayoutLine, LayoutParagraph, LayoutRun, PageLayout, isRTL, lineSize, lineText, paragraphRuns, paragraphText, pieces, textBounds, topLeft,
} from '../engine/layout';
import { Rect, maxX, union } from '../engine/pageContent';
import { formatNumber } from '../engine/contentStream';

export const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const hex = (c: [number, number, number]) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const twips = (pt: number) => Math.round(pt * 20);
const emu = (pt: number) => Math.round(pt * 12700);

export interface ImageData { data: Uint8Array; ext: 'jpeg' | 'png' }
/** Supplies picture data for layout images and page backgrounds (rendered by pdf.js in the app). */
export interface Assets {
  image(page: number, item: { rect: Rect; scan?: boolean; composite?: boolean }): Promise<ImageData | null>;
  /** The app can render a scan's page image with its recognised text painted out (see LayoutImage.scan). */
  scanBackground?: boolean;
  background(page: number, keepText: boolean): Promise<Uint8Array | null>;
}

function zip(files: Record<string, Uint8Array | string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(entries, { level: 6 });
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// MARK: Word

export { docx } from './docx';

// MARK: PowerPoint (editable text over each page's artwork)

const THEME = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MK PDF"><a:themeElements><a:clrScheme name="MK PDF"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="MK PDF"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="MK PDF"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

function slideLines(layout: PageLayout): { line: LayoutLine; align: string; rtl: boolean }[] {
  return layout.items.flatMap((item) => {
    if (item.kind === 'paragraph') return item.lines.flatMap((line) => pieces(line).map((pc) => ({
      line: pc, align: line.parts.length ? 'l' : item.alignment === 'center' ? 'ctr' : item.alignment === 'right' ? 'r' : 'l', rtl: isRTL(lineText(pc)),
    })));
    if (item.kind === 'table') return item.cells.flatMap((c) => c.lines.map((line) => ({
      line, align: c.alignment === 'center' ? 'ctr' : c.alignment === 'right' ? 'r' : 'l', rtl: isRTL(lineText(line)),
    })));
    return [];
  });
}

export async function pptx(layouts: PageLayout[], assets: Assets): Promise<Uint8Array> {
  const first = layouts[0] ?? { width: 612, height: 792 } as PageLayout;
  const cx = emu(first.width), cy = emu(first.height), n = layouts.length;
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const empty = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  const range = [...Array(n).keys()];
  const files: Record<string, Uint8Array | string> = {
    '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
      range.map((i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') + '</Types>',
    '_rels/.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${XML_HEAD}<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${range.map((i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${cy}" cy="${cx}"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
      range.map((i) => `<Relationship Id="rId${i + 3}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('') + '</Relationships>',
    'ppt/slideMasters/slideMaster1.xml': `${XML_HEAD}<p:sldMaster ${ns}>${empty}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `${XML_HEAD}<p:sldLayout ${ns} type="blank">${empty}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/theme/theme1.xml': THEME,
  };
  for (let i = 0; i < n; i++) {
    const layout = layouts[i];
    const lines = slideLines(layout);
    const invisible = lines.length > 0 && lines.every((l) => l.line.runs.every((r) => r.invisible));
    files[`ppt/media/image${i + 1}.jpeg`] = (await assets.background(layout.index, invisible)) ?? new Uint8Array();
    const scale = Math.min(first.width / layout.width, first.height / layout.height);
    let shapes = `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${i + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(layout.width * scale)}" cy="${emu(layout.height * scale)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    lines.forEach(({ line, align, rtl }, k) => {
      const size = lineSize(line);
      const r = topLeft(layout, { x: line.rect.x - 1, y: line.baseline - size * 0.25, w: line.rect.w * 1.08 + 4, h: size * 1.2 });
      const runs = line.runs.map((run) => {
        const fill = run.invisible ? '<a:solidFill><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:solidFill>' : `<a:solidFill><a:srgbClr val="${hex(run.color)}"/></a:solidFill>`;
        const f = xml(run.font.family);
        return `<a:r><a:rPr lang="en-US" sz="${Math.max(100, Math.round(run.size * scale * 100))}"${run.font.bold ? ' b="1"' : ''}${run.font.italic ? ' i="1"' : ''} dirty="0">${fill}<a:latin typeface="${f}"/><a:cs typeface="${f}"/></a:rPr><a:t>${xml(run.text)}</a:t></a:r>`;
      }).join('');
      shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${k + 3}" name="Text ${k + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(r.x * scale)}" y="${emu(r.y * scale)}"/><a:ext cx="${emu(r.w * scale)}" cy="${emu(r.h * scale)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr algn="${align}"${rtl ? ' rtl="1"' : ''}/>${runs}</a:p></p:txBody></p:sp>`;
    });
    files[`ppt/slides/slide${i + 1}.xml`] = `${XML_HEAD}<p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="../media/image${i + 1}.jpeg"/></Relationships>`;
  }
  return zip(files);
}

// MARK: HTML

const b64 = (d: Uint8Array) => { let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000)); return btoa(s); };

export async function html(layouts: PageLayout[], title: string, assets: Assets): Promise<Uint8Array> {
  let pages = '';
  for (const layout of layouts) {
    const lines = slideLines(layout).map((l) => l.line);
    const invisible = lines.length > 0 && lines.every((l) => l.runs.every((r) => r.invisible));
    const bg = await assets.background(layout.index, invisible);
    let spans = '';
    for (const line of lines) {
      const size = lineSize(line);
      const r = topLeft(layout, { x: line.rect.x, y: line.baseline, w: line.rect.w, h: 0 });
      const rtl = isRTL(lineText(line));
      const runs = line.runs.map((run) => {
        let st = `font-family:'${run.font.family.replace(/'/g, '')}',sans-serif;font-size:${formatNumber(run.size)}pt`;
        if (run.font.bold) st += ';font-weight:bold';
        if (run.font.italic) st += ';font-style:italic';
        st += run.invisible ? ';color:transparent' : `;color:#${hex(run.color)}`;
        return `<span style="${st}">${xml(run.text)}</span>`;
      }).join('');
      spans += `<div class="l"${rtl ? ' dir="rtl"' : ''} data-w="${formatNumber(line.rect.w)}" style="left:${formatNumber(r.x)}pt;top:${formatNumber(r.y - size * 0.82)}pt;line-height:${formatNumber(size)}pt">${runs}</div>`;
    }
    pages += `<section class="page" style="width:${formatNumber(layout.width)}pt;height:${formatNumber(layout.height)}pt;background-image:url(data:image/jpeg;base64,${bg ? b64(bg) : ''})">${spans}</section>\n`;
  }
  return strToU8(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(title)}</title>
<style>body{margin:0;background:#e9e9ec}.page{position:relative;margin:24px auto;background-size:100% 100%;box-shadow:0 2px 14px rgba(0,0,0,.18);overflow:hidden}.l{position:absolute;white-space:pre;transform-origin:0 0}.l[dir=rtl]{transform-origin:100% 0}@media print{body{background:none}.page{margin:0;box-shadow:none;page-break-after:always}}</style></head>
<body>${pages}<script>for(const el of document.querySelectorAll('.l')){const t=parseFloat(el.dataset.w)*96/72,a=el.getBoundingClientRect().width;if(a>0)el.style.transform='scaleX('+Math.min(2,Math.max(.5,t/a))+')';if(el.dir==='rtl')el.style.left=(parseFloat(el.style.left)*96/72+t-a)+'px'}</script></body></html>`);
}

// MARK: Excel

export function column(i: number): string {
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function numberCell(s: string): string | null {
  const c = s.replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(c) && c.length < 16 ? c : null;
}

export function xlsx(layouts: PageLayout[]): Uint8Array {
  const sheets: [string, string][] = layouts.map((layout, pi) => {
    const rows: [string, boolean][][] = [];
    const merges: string[] = [];
    const widths = [60];
    for (const item of layout.items) {
      if (item.kind === 'paragraph') rows.push([[paragraphText(item).replace(/\n/g, ' '), paragraphRuns(item).some((r) => r.font.bold)]]);
      else if (item.kind === 'table') {
        if (rows.length) rows.push([]);
        const first = rows.length, n = Math.max(item.rowRects.length, ...item.cells.map((c) => c.row + c.rowSpan));
        for (let r = 0; r < n; r++) rows.push([]);
        // Each cell at its grid position; merged cells become merged ranges.
        for (const c of item.cells) {
          const text = c.lines.map(lineText).join(' ');
          rows[first + c.row][c.col] = [text, c.lines.length > 0 && c.lines.every((l) => l.runs.every((r) => r.font.bold))];
          if (c.rowSpan > 1 || c.colSpan > 1) merges.push(`${column(c.col)}${first + c.row + 1}:${column(c.col + c.colSpan - 1)}${first + c.row + c.rowSpan}`);
        }
        for (const row of rows.slice(first)) for (let k = 0; k < row.length; k++) row[k] ??= ['', false];
        rows.push([]);
        const edges = item.colEdges.length ? item.colEdges : [...item.columns, item.right + 6];
        edges.slice(1).forEach((x, i) => { widths[i] = Math.max(widths[i] ?? 0, x - edges[i]); });
      }
    }
    const body = rows.map((row, r) => `<row r="${r + 1}">` + row.map(([text, bold], c) => {
      if (!text) return '';
      const ref = column(c) + (r + 1), s = bold ? ' s="1"' : '';
      const n = numberCell(text);
      return n ? `<c r="${ref}"${s}><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const cols = '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w / 5.6).toFixed(1)}" customWidth="1"/>`).join('') + '</cols>';
    const merged = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    return [`Page ${pi + 1}`, `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData>${merged}</worksheet>`];
  });
  if (!sheets.length) sheets.push(['Page 1', `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`]);
  const files: Record<string, string> = {
    '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
    '_rels/.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets>${sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach(([, s], i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = s; });
  return zip(files);
}

// MARK: Text, Markdown, CSV, RTF

export function plainText(layouts: PageLayout[]): string {
  return layouts.map((l) => l.items.map((it) => it.kind === 'paragraph' ? paragraphText(it)
    : it.kind === 'table' ? it.rows.map((r) => r.map((c) => (c ? lineText(c) : '')).join('\t')).join('\n') : '').filter(Boolean).join('\n\n')).join('\n\n\f');
}

export async function markdown(layouts: PageLayout[], assets?: Assets): Promise<string> {
  const sizes = layouts.flatMap((l) => l.items.filter((i): i is LayoutParagraph => i.kind === 'paragraph').map((p) => lineSize(p.lines[0]))).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] ?? 12;
  const inline = (runs: LayoutRun[]) => runs.map((r) => {
    const t = r.text.replace(/([*_])/g, '\\$1').replace(/\n/g, '  \n');
    const core = t.trim();
    if (!core) return t;
    let w = core;
    if (r.font.bold) w = `**${w}**`;
    if (r.font.italic) w = `*${w}*`;
    return t.match(/^ */)![0] + w + t.match(/ *$/)![0];
  }).join('');
  const out: string[] = [];
  let images = 0;
  for (const l of layouts) {
    for (const it of l.items) {
      if (it.kind === 'paragraph') {
        const text = paragraphText(it).trim().replace(/\n/g, ' '), size = lineSize(it.lines[0]), runs = paragraphRuns(it);
        if (size >= body * 1.6) out.push('# ' + text);
        else if (size >= body * 1.25) out.push('## ' + text);
        else if (size >= body * 1.1 && runs.every((r) => r.font.bold)) out.push('### ' + text);
        else if (/^[•●▪◦–-]/.test(text)) out.push('- ' + inline(runs).replace(/^[•●▪◦–\- ]+/, ''));
        else out.push(inline(runs));
      } else if (it.kind === 'table') {
        const rows = it.rows.map((r) => '| ' + r.map((c) => (c ? lineText(c) : '').replace(/\|/g, '\\|')).join(' | ') + ' |');
        if (rows.length) out.push([rows[0], '|' + ' --- |'.repeat(it.columns.length), ...rows.slice(1)].join('\n'));
      } else if (assets) {
        const img = await assets.image(l.index, it);
        if (img) out.push(`![Image ${++images}](data:image/${img.ext};base64,${b64(img.data)})`);
      }
    }
    out.push('---');
  }
  if (out[out.length - 1] === '---') out.pop();
  return out.join('\n\n') + '\n';
}

export function csv(layouts: PageLayout[]): string {
  const rows = layouts.flatMap((l) => l.items.flatMap((it) => it.kind === 'paragraph' ? [[paragraphText(it)]]
    : it.kind === 'table' ? it.rows.map((r) => r.map((c) => (c ? lineText(c) : ''))) : []));
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function rtf(layouts: PageLayout[]): string {
  const fonts: string[] = [], colors: string[] = [];
  const fi = (f: string) => { let i = fonts.indexOf(f); if (i < 0) { fonts.push(f); i = fonts.length - 1; } return i; };
  const ci = (c: [number, number, number]) => {
    const k = c.map((v) => Math.round(v * 255)).join(',');
    let i = colors.indexOf(k); if (i < 0) { colors.push(k); i = colors.length - 1; } return i + 1;
  };
  const esc = (s: string) => Array.from(s).map((ch) => {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') return '\\' + ch;
    if (ch === '\t') return '\\tab ';
    if (c > 127) return c > 0xffff ? `\\u${((c - 0x10000) >> 10) + 0xd800 - 65536}?\\u${((c - 0x10000) & 0x3ff) + 0xdc00 - 65536}?` : `\\u${c > 32767 ? c - 65536 : c}?`;
    return ch;
  }).join('');
  const run = (r: LayoutRun) => `{\\f${fi(r.font.family)}\\fs${Math.round(r.size * 2)}\\cf${ci(r.color)}${r.font.bold ? '\\b' : ''}${r.font.italic ? '\\i' : ''} ${esc(r.text)}}`;
  let body = '';
  layouts.forEach((l, pi) => {
    for (const it of l.items) {
      if (it.kind === 'paragraph') {
        const q = it.alignment === 'center' ? '\\qc' : it.alignment === 'right' ? '\\qr' : it.alignment === 'justify' ? '\\qj' : '\\ql';
        body += `{\\pard${it.rtl ? '\\rtlpar' : ''}${q}\\sb120 ${paragraphRuns(it).map(run).join('')}\\par}\n`;
      } else if (it.kind === 'table') {
        for (const row of it.rows) {
          let x = 0;
          body += '\\trowd\\trgaph60' + it.columns.map((s, i) => { x += Math.round(((i + 1 < it.columns.length ? it.columns[i + 1] : it.right + 6) - s) * 20); return `\\cellx${x}`; }).join('');
          body += row.map((c) => `\\pard\\intbl ${c ? c.runs.map(run).join('') : ''}\\cell`).join('') + '\\row\n';
        }
      }
    }
    if (pi < layouts.length - 1) body += '\\page\n';
  });
  return `{\\rtf1\\ansi\\uc1\\deff0{\\fonttbl${fonts.map((f, i) => `{\\f${i} ${esc(f)};}`).join('')}}{\\colortbl;${colors.map((c) => { const [r, g, b] = c.split(','); return `\\red${r}\\green${g}\\blue${b};`; }).join('')}}\n${body}}`;
}
