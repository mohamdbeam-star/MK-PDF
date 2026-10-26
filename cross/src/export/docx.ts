// PDF → Word. Each PDF page becomes its own Word section (same page size), with repeated page furniture in
// the section's header and footer, body text placed at the PDF's vertical positions, and ruled tables rebuilt
// cell for cell (merged cells, shading, borders, row heights).
import { strToU8, zipSync } from 'fflate';
import {
  LayoutBox, LayoutCell, LayoutImage, LayoutItem, LayoutParagraph, LayoutRun, LayoutTable, PageLayout, lineSize, paragraphRuns, topLeft,
} from '../engine/layout';
import { Rect, maxX, maxY, union } from '../engine/pageContent';
import type { Assets } from './writers';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const hex = (c: [number, number, number]) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const unionRect = (a: Rect, b: Rect) => union(a, b)!;
const tw = (pt: number) => Math.max(0, Math.round(pt * 20));
const emu = (pt: number) => Math.round(pt * 12700);

/** One XML part (document, header or footer) with its own image relationships. */
class Part {
  media: { id: string; target: string }[] = [];
  constructor(readonly name: string) {}
}

interface Placed<T extends LayoutItem = LayoutItem> { item: T; r: Rect }
/** Boxes side by side (cards), or one box (a banner, a notice), with the paragraphs inside each. */
interface BoxRow { boxes: { box: LayoutBox; r: Rect; items: Placed<LayoutParagraph>[] }[]; r: Rect }
type Entry = Placed | { row: BoxRow; r: Rect };

const dark = (c: [number, number, number] | null) => !!c && 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 0.55;
const cellParagraph = (c: LayoutCell): LayoutParagraph => ({
  kind: 'paragraph', rect: c.lines.reduce<Rect>((a, l) => union(a, l.rect)!, c.lines[0].rect), lines: c.lines, alignment: c.alignment, rtl: c.rtl, pitch: c.pitch,
});

export async function docx(layouts: PageLayout[], assets?: Assets): Promise<Uint8Array> {
  const files: Record<string, Uint8Array | string> = {};
  let imageCount = 0, drawingId = 0;

  // Body font and size: the most used ones become the document defaults.
  const famCount = new Map<string, number>(), sizeCount = new Map<number, number>();
  for (const l of layouts) for (const it of l.items) if (it.kind === 'paragraph') for (const r of paragraphRuns(it)) {
    famCount.set(r.font.family, (famCount.get(r.font.family) ?? 0) + r.text.length);
    sizeCount.set(Math.round(r.size * 2), (sizeCount.get(Math.round(r.size * 2)) ?? 0) + r.text.length);
  }
  const top = <K,>(m: Map<K, number>, d: K) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? d;
  const bodyFont = top(famCount, 'Calibri'), bodySize = top(sizeCount, 22);

  const families = new Set<string>();
  const runXML = (r: LayoutRun, rtl: boolean, onColour = false) => {
    families.add(r.font.family);
    const f = xml(r.font.family);
    let p = `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`;
    if (r.font.bold) p += '<w:b/><w:bCs/>';
    if (r.font.italic) p += '<w:i/><w:iCs/>';
    // OCR'd text is invisible in the PDF but is the real content in Word.
    // White text only stays white where something dark is drawn behind it.
    const pale = r.color.every((c) => c > 0.9);
    if (!r.invisible && hex(r.color) !== '000000' && (onColour || !pale)) p += `<w:color w:val="${hex(r.color)}"/>`;
    const hp = Math.max(2, Math.round(r.size * 2));
    if (r.rise) p += `<w:position w:val="${Math.round(r.rise * 2)}"/>`;
    p += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
    if (rtl) p += '<w:rtl/>';
    const content = r.text.split('\n').map((line) => line.split('\t').map((t) => (t ? `<w:t xml:space="preserve">${xml(t)}</w:t>` : '')).join('<w:tab/>')).join('<w:br/>');
    return `<w:r><w:rPr>${p}</w:rPr>${content}</w:r>`;
  };

  const picture = async (part: Part, layout: PageLayout, img: LayoutImage) => {
    const data = assets ? await assets.image(layout.index, img) : null;
    if (!data) return null;
    const name = `image${++imageCount}.${data.ext}`;
    files[`word/media/${name}`] = data.data;
    const id = `rIdImg${part.media.length + 1}`;
    part.media.push({ id, target: `media/${name}` });
    drawingId++;
    return (cx: number, cy: number) => `<wp:docPr id="${drawingId}" name="Picture ${drawingId}"/><wp:cNvGraphicFramePr/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  };
  /** A picture pinned to an exact spot on the page, not taking part in the text flow. */
  const anchored = async (part: Part, layout: PageLayout, p: Placed<LayoutImage>, z: number) => {
    const g = await picture(part, layout, p.item);
    if (!g) return '';
    const cx = emu(p.r.w), cy = emu(p.r.h);
    return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251658240 + z}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
      `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(p.r.x)}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(p.r.y)}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${g(cx, cy)}</wp:anchor></w:drawing></w:r>`;
  };

  /** Paragraph properties and runs, positioned against a frame (page margins or a table cell). */
  const paragraphXML = (layout: PageLayout, p: LayoutParagraph, frameLeft: number, frameRight: number, before: number, lineHeight: number | null, extra = '', onPage = true, onColour = false) => {
    let ppr = p.rtl ? '<w:bidi/>' : '';
    const jc = p.alignment === 'center' ? 'center' : p.alignment === 'justify' ? 'both' : p.alignment === 'right' ? (p.rtl ? 'left' : 'right') : p.rtl ? 'right' : 'left';
    ppr += `<w:spacing w:before="${tw(before)}" w:after="0" ` + (lineHeight ? `w:line="${tw(lineHeight)}" w:lineRule="exact"/>` : 'w:line="240" w:lineRule="auto"/>');
    const r = topLeft(layout, p.rect);
    // Indents are measured from the frame (page margins or cell edges) and may be negative.
    const ind = (v: number) => Math.round(v * 20);
    if (p.alignment === 'center') {
      if (onPage) {
        // Centre on the same point as the PDF, whatever the margins: a window symmetric around the text.
        const c = r.x + r.w / 2, half = Math.max(r.w / 2 + 2, Math.min(c, layout.width - c) - 4);
        ppr += `<w:ind w:left="${ind(c - half - frameLeft)}" w:right="${ind(frameRight - (c + half))}"/>`;
      }
    } else if (p.backdrop && onPage && !p.rtl) {
      // A band: the shading spans the band; the first line starts where the text does.
      const band = topLeft(layout, p.backdrop.rect);
      const firstX = topLeft(layout, p.lines[0].rect).x;
      ppr += `<w:ind w:left="${ind(band.x - frameLeft)}" w:right="${ind(frameRight - maxX(band))}" w:firstLine="${tw(firstX - band.x)}"/>`;
    } else {
      const firstX = topLeft(layout, p.lines[0].rect).x;
      const restX = p.lines.length > 1 ? topLeft(layout, p.lines[1].rect).x : firstX;
      const multi = p.lines.length > 1;
      const start = p.rtl ? frameRight - maxX(r) : restX - frameLeft;
      // A single line never wraps in Word: it gets the rest of the frame.
      // Wrapped lines get a little slack, so a substitute font doesn't push a word to the next line.
      const slack = Math.max(3, r.w * 0.03);
      const end = multi ? (p.rtl ? r.x - frameLeft - slack : frameRight - maxX(r) - slack) : Math.min(0, p.rtl ? r.x - frameLeft - 6 : frameRight - maxX(r) - 6);
      const first = p.rtl ? 0 : firstX - restX;
      ppr += `<w:ind w:${p.rtl ? 'right' : 'left'}="${ind(onPage ? start : Math.max(0, start))}" w:${p.rtl ? 'left' : 'right'}="${ind(onPage ? end : Math.max(0, end))}"` +
        (Math.abs(first) > 2 ? (first > 0 ? ` w:firstLine="${tw(first)}"` : ` w:hanging="${tw(-first)}"`) : '') + '/>';
    }
    const stops = p.lines[0].tabStops;
    if (stops.length) ppr += '<w:tabs>' + stops.map((x) => `<w:tab w:val="left" w:pos="${tw(topLeft(layout, { x, y: p.rect.y, w: 0, h: 0 }).x - frameLeft)}"/>`).join('') + '</w:tabs>';
    if (p.backdrop) ppr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(p.backdrop.color)}"/>`;
    ppr += `<w:jc w:val="${jc}"/>`;
    return `<w:p><w:pPr>${ppr}</w:pPr>${extra}${paragraphRuns(p).map((x) => runXML(x, p.rtl, !!p.backdrop || !!p.onImage || onColour)).join('')}</w:p>`;
  };
  const lineHeightOf = (p: { lines: LayoutParagraph['lines']; pitch: number }) => {
    const size = lineSize(p.lines[0]);
    return p.lines.length > 1 && p.pitch > size * 0.9 && p.pitch < size * 2.4 ? p.pitch : Math.max(size * 1.18, 4);
  };
  /** Line height and the top of the first line, so the first baseline lands where it is in the PDF. */
  const placement = (layout: PageLayout, para: LayoutParagraph) => {
    if (para.backdrop && para.lines.length === 1) {
      const band = topLeft(layout, para.backdrop.rect);
      return { lh: Math.max(band.h, lineSize(para.lines[0]) * 1.1), top: band.y };
    }
    const lh = lineHeightOf(para);
    const base = topLeft(layout, { x: para.rect.x, y: para.lines[0].baseline, w: 0, h: 0 }).y;
    return { lh, top: base - (lh - lineSize(para.lines[0]) * 0.22) };
  };
  const spacer = (h: number, extra = '') => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.max(20, tw(h))}" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${extra}</w:p>`;

  const tableXML = (layout: PageLayout, t: LayoutTable, frameLeft: number) => {
    const edges = t.colEdges.map((x) => topLeft(layout, { x, y: t.rect.y, w: 0, h: 0 }).x).sort((a, b) => a - b);
    const widths = edges.slice(1).map((x, i) => Math.max(6, x - edges[i]));
    const rowsN = t.ruled ? t.rowEdges.length - 1 : t.rowRects.length;
    const heights = t.ruled ? t.rowEdges.slice(1).map((y, i) => t.rowEdges[i] - y) : t.rowRects.map(() => 0);
    const color = hex(t.borderColor ?? [0.5, 0.5, 0.5]);
    const padL = t.ruled ? 4 : 0;
    let out = `<w:tbl><w:tblPr><w:tblW w:w="${tw(widths.reduce((a, b) => a + b, 0))}" w:type="dxa"/>` +
      `<w:tblInd w:w="${tw(edges[0] - frameLeft)}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
      `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${tw(padL)}" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="${tw(padL)}" w:type="dxa"/></w:tblCellMar>` +
      `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${tw(w)}"/>`).join('')}</w:tblGrid>`;
    const at = new Map<string, LayoutCell>();
    for (const c of t.cells) at.set(`${c.row}:${c.col}`, c);
    const owner = (row: number, col: number) => t.cells.find((c) => row >= c.row && row < c.row + c.rowSpan && col >= c.col && col < c.col + c.colSpan);
    for (let row = 0; row < rowsN; row++) {
      out += '<w:tr><w:trPr><w:cantSplit/>' + (heights[row] > 2 ? `<w:trHeight w:val="${tw(heights[row])}" w:hRule="atLeast"/>` : '') + '</w:trPr>';
      for (let col = 0; col < widths.length;) {
        const c = owner(row, col);
        const span = c ? c.colSpan : 1;
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        let tcPr = `<w:tcW w:w="${tw(w)}" w:type="dxa"/>` + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '');
        if (c && c.rowSpan > 1) tcPr += c.row === row ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
        if (c) {
          const b = c.borders, edge = (on: boolean) => (on ? `w:val="single" w:sz="4" w:space="0" w:color="${color}"` : 'w:val="nil"');
          tcPr += t.ruled || t.bordered
            ? `<w:tcBorders><w:top ${edge(t.ruled ? b.top : true)}/><w:left ${edge(t.ruled ? b.left : false)}/><w:bottom ${edge(t.ruled ? b.bottom : true)}/><w:right ${edge(t.ruled ? b.right : false)}/></w:tcBorders>`
            : '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>';
          if (c.fill) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.fill)}"/>`;
          tcPr += `<w:vAlign w:val="${c.valign === 'center' ? 'center' : c.valign === 'bottom' ? 'bottom' : 'top'}"/>`;
        }
        let content = '';
        if (c && c.row === row && c.lines.length) {
          const p: LayoutParagraph = { kind: 'paragraph', rect: c.lines.reduce<Rect>((a, l) => ({ x: Math.min(a.x, l.rect.x), y: Math.min(a.y, l.rect.y), w: Math.max(maxX(a), maxX(l.rect)) - Math.min(a.x, l.rect.x), h: Math.max(maxY(a), maxY(l.rect)) - Math.min(a.y, l.rect.y) }), c.lines[0].rect),
            lines: c.lines, alignment: c.alignment, rtl: c.rtl, pitch: c.pitch };
          const cellR = topLeft(layout, c.rect);
          // Inside the cell the paragraph is placed against the cell's own edges (minus its padding).
          const pad = c.valign === 'top' && t.ruled ? Math.max(0, topLeft(layout, p.rect).y - cellR.y - 1) : 0;
          content = paragraphXML(layout, p, cellR.x + padL, maxX(cellR) - padL, Math.min(pad, 12), p.lines.length > 1 ? lineHeightOf(p) : null, '', false, !!c.fill);
        }
        out += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${content || '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>'}</w:tc>`;
        col += span;
      }
      out += '</w:tr>';
    }
    return out + '</w:tbl>';
  };

  /** A row of boxes as a one-row table: each box a cell with its fill, borders and padding, gaps as empty cells. */
  const boxRowXML = (layout: PageLayout, row: BoxRow, frameLeft: number) => {
    const cols: { w: number; b?: BoxRow['boxes'][number] }[] = [];
    let x = row.boxes[0].r.x;
    for (const b of row.boxes) {
      if (b.r.x - x > 0.5) cols.push({ w: b.r.x - x });
      cols.push({ w: b.r.w, b });
      x = maxX(b.r);
    }
    const height = Math.max(...row.boxes.map((b) => b.r.h));
    const nil = '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>';
    let out = `<w:tbl><w:tblPr><w:tblW w:w="${tw(cols.reduce((a, c) => a + c.w, 0))}" w:type="dxa"/><w:tblInd w:w="${Math.round((row.boxes[0].r.x - frameLeft) * 20)}" w:type="dxa"/>` +
      '<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
      `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${cols.map((c) => `<w:gridCol w:w="${tw(c.w)}"/>`).join('')}</w:tblGrid>` +
      `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="${tw(height)}" w:hRule="atLeast"/></w:trPr>`;
    for (const c of cols) {
      if (!c.b) { out += `<w:tc><w:tcPr><w:tcW w:w="${tw(c.w)}" w:type="dxa"/>${nil}</w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p></w:tc>`; continue; }
      const { box, r, items } = c.b;
      const sorted = [...items].sort((a, b) => a.r.y - b.r.y);
      const side = (k: 'top' | 'left' | 'bottom' | 'right') => {
        const s = box.borders[k];
        return s ? `<w:${k} w:val="single" w:sz="${Math.min(96, Math.max(2, Math.round(s.width * 8)))}" w:space="0" w:color="${hex(s.color)}"/>` : `<w:${k} w:val="nil"/>`;
      };
      let tcPr = `<w:tcW w:w="${tw(c.w)}" w:type="dxa"/><w:tcBorders>${side('top')}${side('left')}${side('bottom')}${side('right')}</w:tcBorders>`;
      if (box.fill) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(box.fill)}"/>`;
      tcPr += '<w:vAlign w:val="top"/>';
      // Inside the box each paragraph keeps its height from the box's top edge.
      let cursor = r.y, content = '';
      for (const it of sorted) {
        const para: LayoutParagraph = { ...it.item, backdrop: undefined };
        const { lh, top } = placement(layout, para);
        const before = Math.max(0, top - cursor);
        // The box's padding is each paragraph's indent from the cell edges (renderers agree on indents).
        content += paragraphXML(layout, para, r.x, maxX(r), before, lh, '', false, dark(box.fill));
        cursor += before + lh * para.lines.length;
      }
      out += `<w:tc><w:tcPr>${tcPr}</w:tcPr>${content || '<w:p/>'}</w:tc>`;
    }
    return out + '</w:tr></w:tbl>';
  };

  /** Header or footer furniture: lines and pictures at fixed positions. */
  const furniture = async (layout: PageLayout, items: Placed[], part: Part, zone: { top: number; left: number; right: number }) => {
    let body = '', cursor = zone.top, z = 0, pending = '';
    for (const p of items) {
      if (p.item.kind === 'image') { pending += await anchored(part, layout, p as Placed<LayoutImage>, z++); continue; }
      if (p.item.kind !== 'paragraph') continue;
      const para = p.item, { lh, top: lineTop } = placement(layout, para);
      const before = Math.max(0, lineTop - cursor);
      body += paragraphXML(layout, para, zone.left, zone.right, before, lh, pending);
      pending = '';
      cursor += before + lh * para.lines.length;
    }
    if (pending || !body) body += `<w:p>${pending}</w:p>`;
    return body;
  };

  const doc = new Part('document');
  const headers: { name: string; xml: string; part: Part; kind: 'header' | 'footer' }[] = [];
  const emptyRefs: Partial<Record<'header' | 'footer', string>> = {};
  const addFurniture = (kind: 'header' | 'footer', body: string, part: Part) => {
    const same = headers.find((h) => h.kind === kind && h.xml === body && !part.media.length && !h.part.media.length);
    if (same) return same.name;
    const name = `${kind}${headers.filter((h) => h.kind === kind).length + 1}`;
    headers.push({ name, xml: body, part, kind });
    return name;
  };
  const anyFurniture = { header: false, footer: false };
  const sections: { width: number; height: number; margins: { t: number; r: number; b: number; l: number; header: number; footer: number }; header?: string; footer?: string }[] = [];
  const bodies: string[] = [];

  // Page furniture is what repeats: an item counts as header/footer only if the same text (numbers aside) or a
  // picture of the same size sits in the same zone on another page (so "Page 1 of 2" and "Page 2 of 2" match).
  const keyOf = (item: LayoutItem) => (item.kind === 'paragraph' ? 'p:' + paragraphRuns(item).map((r) => r.text).join('').replace(/\d+/g, '#').trim()
    : item.kind === 'image' ? `i:${Math.round(item.rect.w)}x${Math.round(item.rect.h)}` : 't');
  const zoneKeys = (zone: 'top' | 'bottom') => layouts.map((l) => new Set(l.items.filter((it) => {
    const r = topLeft(l, it.rect);
    return zone === 'top' ? maxY(r) <= l.height * 0.13 : r.y >= l.height * 0.87;
  }).map(keyOf)));
  const topKeys = zoneKeys('top'), bottomKeys = zoneKeys('bottom');
  const repeats = (keys: Set<string>[], page: number, item: LayoutItem) => keys.some((k, i) => i !== page && k.has(keyOf(item)));

  for (const [pageNo, layout] of layouts.entries()) {
    // A paragraph on a band occupies the whole band.
    const extent = (item: LayoutItem) => (item.kind === 'paragraph' && item.backdrop ? unionRect(item.rect, item.backdrop.rect) : item.rect);
    const placed: Placed[] = layout.items.map((item) => ({ item, r: topLeft(layout, extent(item)) }));
    const H = layout.height, W = layout.width;
    // Furniture: leading items in the top 13% and trailing items in the bottom 13%, set apart from the body.
    let h = 0;
    while (h < placed.length && placed[h].item.kind !== 'table' && maxY(placed[h].r) <= H * 0.13 && repeats(topKeys, pageNo, placed[h].item)) h++;
    if (h && h < placed.length && placed[h].r.y - Math.max(...placed.slice(0, h).map((p) => maxY(p.r))) < 8) h = 0;
    let f = placed.length;
    while (f > h && placed[f - 1].item.kind !== 'table' && placed[f - 1].r.y >= H * 0.87 && repeats(bottomKeys, pageNo, placed[f - 1].item)) f--;
    if (f < placed.length && f > h && placed[f].r.y - Math.max(...placed.slice(h, f).map((p) => maxY(p.r))) < 8) f = placed.length;
    if (f === h) { h = 0; f = placed.length; } // nothing but furniture: keep it all in the body
    const head = placed.slice(0, h), foot = placed.slice(f), body = placed.slice(h, f);

    const bodyRects = body.map((p) => p.r);
    const left = Math.min(W * 0.3, Math.max(18, Math.min(...bodyRects.map((r) => r.x), W)));
    const right = Math.min(W * 0.3, Math.max(18, W - Math.max(...bodyRects.map((r) => maxX(r)), 0)));
    const headBottom = head.length ? Math.max(...head.map((p) => maxY(p.r))) : 0;
    const footTop = foot.length ? Math.min(...foot.map((p) => p.r.y)) : H;
    const firstTop = body.length ? Math.min(...bodyRects.map((r) => r.y)) : 54;
    const lastBottom = body.length ? Math.max(...bodyRects.map((r) => maxY(r))) : H - 36;
    const marginT = head.length ? Math.max(18, Math.min(headBottom + 2, firstTop)) : Math.max(14, Math.min(firstTop - 2, 54));
    const marginB = foot.length ? Math.max(14, H - footTop + 2) : Math.max(14, Math.min(H - lastBottom - 2, 36));
    const headerDist = head.length ? Math.max(0, Math.min(...head.map((p) => p.r.y)) - 1) : 18;
    const footerDist = foot.length ? Math.max(0, H - Math.max(...foot.map((p) => maxY(p.r))) - 1) : 18;

    const footerGap = (items: Placed[], top: number) => Math.max(0, Math.min(...items.map((p) => p.r.y)) - top);
    const sec: (typeof sections)[number] = { width: W, height: H, margins: { t: marginT, r: right, b: marginB, l: left, header: headerDist, footer: footerDist } };
    if (head.length) { const part = new Part(''); sec.header = addFurniture('header', await furniture(layout, head, part, { top: headerDist, left, right: W - right }), part); anyFurniture.header = true; }
    if (foot.length) { const part = new Part(''); sec.footer = addFurniture('footer', await furniture(layout, foot, part, { top: H - marginB + footerGap(foot, H - marginB), left, right: W - right }), part); anyFurniture.footer = true; }

    // Body: every paragraph's first baseline lands where it is in the PDF.
    let out = '', cursor = marginT, pending = '', z = 0;
    const frameRight = W - right;
    const bodyTop = head.length ? headBottom : 0, bodyBottom = foot.length ? footTop : H;
    const dividers = layout.rules.map((d) => ({ r: topLeft(layout, d.rect), color: d.color })).filter((d) => d.r.y > bodyTop && d.r.y < bodyBottom).sort((a, b) => a.r.y - b.r.y);
    /** Divider lines above `y` become empty paragraphs with a bottom border at the line's height. */
    const flushDividers = (y: number) => {
      while (dividers.length && dividers[0].r.y <= y) {
        const d = dividers.shift()!;
        const h = d.r.y - cursor - 0.5;
        if (h < -2) continue;
        out += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="${Math.max(2, Math.round(Math.max(d.r.h, 0.5) * 8))}" w:space="0" w:color="${hex(d.color)}"/></w:pBdr>` +
          `<w:spacing w:before="0" w:after="0" w:line="${Math.max(20, tw(h))}" w:lineRule="exact"/><w:ind w:left="${Math.round((d.r.x - left) * 20)}" w:right="${Math.round((frameRight - maxX(d.r)) * 20)}"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
        cursor = Math.max(cursor + 1, d.r.y + 0.5);
      }
    };
    // Boxes (banners, notices, cards) take the paragraphs inside them; an unruled table laid over several boxes
    // (cards side by side) gives each cell's text to its box.
    const boxes = layout.boxes.map((box) => ({ box, r: topLeft(layout, box.rect), items: [] as Placed<LayoutParagraph>[] }))
      .filter((b) => b.r.y >= bodyTop - 1 && maxY(b.r) <= bodyBottom + 1);
    const ownerOf = (r: Rect) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      return boxes.filter((b) => cx >= b.r.x && cx <= maxX(b.r) && cy >= b.r.y && cy <= maxY(b.r)).sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h)[0];
    };
    const flow: Entry[] = [];
    for (const p of body) {
      if (p.item.kind === 'paragraph') {
        const o = ownerOf(p.r);
        if (o) { o.items.push(p as Placed<LayoutParagraph>); continue; }
      } else if (p.item.kind === 'table' && !p.item.ruled && boxes.length) {
        const cells = p.item.cells.filter((c) => c.lines.length).map((c) => { const item = cellParagraph(c); return { item, r: topLeft(layout, item.rect) }; });
        if (cells.length && cells.every((c) => ownerOf(c.r))) { cells.forEach((c) => ownerOf(c.r)!.items.push(c)); continue; }
      }
      flow.push(p);
    }
    // A box holding other boxes gives its own paragraphs back to the page; boxes side by side share a row.
    const used = boxes.filter((b) => b.items.length);
    const holders = used.filter((b) => used.some((o) => o !== b && o.r.x >= b.r.x - 0.5 && maxX(o.r) <= maxX(b.r) + 0.5 && o.r.y >= b.r.y - 0.5 && maxY(o.r) <= maxY(b.r) + 0.5));
    for (const b of holders) flow.push(...b.items);
    const rows: BoxRow[] = [];
    for (const b of used.filter((x) => !holders.includes(x)).sort((a, c) => a.r.y - c.r.y)) {
      const row = rows.find((rw) => rw.boxes.some((o) => Math.min(maxY(o.r), maxY(b.r)) - Math.max(o.r.y, b.r.y) > Math.min(o.r.h, b.r.h) * 0.5));
      if (row) { row.boxes.push(b); row.r = union(row.r, b.r)!; } else rows.push({ boxes: [b], r: { ...b.r } });
    }
    for (const row of rows) {
      // Charts and diagrams go in as a picture of the box (their text is part of the drawing).
      for (const f of row.boxes.filter((b) => b.box.figure)) flow.push({ item: { kind: 'image', rect: f.box.rect } as LayoutImage, r: f.r });
      row.boxes = row.boxes.filter((b) => !b.box.figure).sort((a, c) => a.r.x - c.r.x);
      if (row.boxes.length) flow.push({ row, r: row.boxes.reduce<Rect>((a, b) => union(a, b.r)!, row.boxes[0].r) });
    }
    flow.sort((a, b) => (Math.abs(a.r.y - b.r.y) > 2 ? a.r.y - b.r.y : a.r.x - b.r.x));

    for (let i = 0; i < flow.length; i++) {
      const entry = flow[i];
      flushDividers(entry.r.y);
      if ('row' in entry) {
        const gap = entry.r.y - cursor;
        if (gap > 0.5 || pending) out += spacer(Math.max(gap, 1), pending);
        pending = '';
        out += boxRowXML(layout, entry.row, left);
        cursor = Math.max(cursor, maxY(entry.r));
        continue;
      }
      const p = entry;
      if (p.item.kind === 'image') {
        const r = p.r;
        const besideText = flow.some((o) => o !== p && !('item' in o && o.item.kind === 'image') && o.r.y < maxY(r) - 2 && maxY(o.r) > r.y + 2);
        if (besideText || r.y < cursor - 2) { pending += await anchored(doc, layout, p as Placed<LayoutImage>, z++); continue; }
        const g = await picture(doc, layout, p.item);
        if (!g) continue;
        const centered = Math.abs(r.x + r.w / 2 - W / 2) < 12;
        const before = Math.max(0, r.y - cursor);
        out += `<w:p><w:pPr><w:spacing w:before="${tw(before)}" w:after="0" w:line="${tw(r.h + 1)}" w:lineRule="exact"/>` +
          (centered ? '<w:jc w:val="center"/>' : `<w:ind w:left="${tw(r.x - left)}"/>`) +
          `</w:pPr>${pending}<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu(r.w)}" cy="${emu(r.h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${g(emu(r.w), emu(r.h))}</wp:inline></w:drawing></w:r></w:p>`;
        pending = '';
        cursor += before + r.h + 1;
      } else if (p.item.kind === 'paragraph') {
        const para = p.item, { lh, top: lineTop } = placement(layout, para);
        const before = Math.max(0, lineTop - cursor);
        out += paragraphXML(layout, para, left, frameRight, before, lh, pending);
        pending = '';
        cursor += before + lh * para.lines.length;
      } else {
        const t = p.item;
        const gap = p.r.y - cursor;
        if (gap > 0.5 || pending) out += spacer(Math.max(gap, 1), pending);
        pending = '';
        out += tableXML(layout, t, left);
        cursor = Math.max(cursor, maxY(p.r));
      }
    }
    flushDividers(bodyBottom);
    if (pending) out += spacer(1, pending);
    bodies.push(out);
    sections.push(sec);
  }

  // Sections without a header/footer get an empty one, so they don't inherit the previous page's.
  for (const kind of ['header', 'footer'] as const) {
    if (!anyFurniture[kind]) continue;
    for (const s of sections) if (!s[kind]) s[kind] = emptyRefs[kind] ??= addFurniture(kind, '<w:p/>', new Part(''));
  }
  const relId = (name: string) => `rId_${name}`;
  const sectPr = (s: (typeof sections)[number]) => {
    const m = s.margins;
    return '<w:sectPr>' + (s.header ? `<w:headerReference w:type="default" r:id="${relId(s.header)}"/>` : '') + (s.footer ? `<w:footerReference w:type="default" r:id="${relId(s.footer)}"/>` : '') +
      `<w:pgSz w:w="${tw(s.width)}" w:h="${tw(s.height)}"${s.width > s.height ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${tw(m.t)}" w:right="${tw(m.r)}" w:bottom="${tw(m.b)}" w:left="${tw(m.l)}" w:header="${tw(m.header)}" w:footer="${tw(m.footer)}" w:gutter="0"/></w:sectPr>`;
  };
  let bodyXML = '';
  bodies.forEach((b, i) => {
    bodyXML += b;
    // Every page but the last ends with a tiny paragraph carrying its section (and so its page size and margins).
    if (i < bodies.length - 1) bodyXML += `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sectPr(sections[i])}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
  });
  bodyXML += sections.length ? sectPr(sections[sections.length - 1]) : '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';

  const rels = (part: Part, extra = '') => `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra}` +
    part.media.map((m) => `<Relationship Id="${m.id}" Type="${REL}/image" Target="${m.target}"/>`).join('') + '</Relationships>';
  for (const h of headers) {
    const tag = h.kind === 'header' ? 'w:hdr' : 'w:ftr';
    files[`word/${h.name}.xml`] = `${XML_HEAD}<${tag} ${NS}>${h.xml}</${tag}>`;
    files[`word/_rels/${h.name}.xml.rels`] = rels(h.part);
  }
  const bf = xml(bodyFont);
  files['[Content_Types].xml'] = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
    headers.map((h) => `<Override PartName="/word/${h.name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${h.kind}+xml"/>`).join('') + '</Types>';
  files['_rels/.rels'] = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
  files['word/_rels/document.xml.rels'] = rels(doc, `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/><Relationship Id="rIdFonts" Type="${REL}/fontTable" Target="fontTable.xml"/>` +
    headers.map((h) => `<Relationship Id="${relId(h.name)}" Type="${REL}/${h.kind}" Target="${h.name}.xml"/>`).join(''));
  // Fonts with a fallback: a PC without the PDF's font (often a web font such as Roboto or Inter) gets a common
  // one of the same kind instead of whatever Word picks.
  const fallback = (family: string): [string, string] => {
    const f = family.toLowerCase();
    if (/mono|courier|consol|code|menlo/.test(f)) return ['Courier New', 'modern'];
    if (/serif|times|georgia|garamond|cambria|book|minion|merriweather|playfair|lora|baskerville|palatino/.test(f) && !/sans/.test(f)) return ['Times New Roman', 'roman'];
    return ['Arial', 'swiss'];
  };
  families.add(bodyFont);
  files['word/fontTable.xml'] = `${XML_HEAD}<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    [...families].map((f) => { const [alt, kind] = fallback(f); return `<w:font w:name="${xml(f)}">${alt !== f ? `<w:altName w:val="${alt}"/>` : ''}<w:family w:val="${kind}"/><w:pitch w:val="${kind === 'modern' ? 'fixed' : 'variable'}"/></w:font>`; }).join('') +
    '</w:fonts>';
  files['word/settings.xml'] = `${XML_HEAD}<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  files['word/styles.xml'] = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${bf}" w:hAnsi="${bf}" w:cs="${bf}" w:eastAsia="${bf}"/><w:sz w:val="${bodySize}"/><w:szCs w:val="${bodySize}"/><w:lang w:val="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>';
  files['word/document.xml'] = `${XML_HEAD}<w:document ${NS}><w:body>${bodyXML}</w:body></w:document>`;

  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(entries, { level: 6 });
}
