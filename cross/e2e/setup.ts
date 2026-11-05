// Builds the test PDFs and images once per run into e2e/.data.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const DATA = path.join(import.meta.dirname, '.data');

async function report() {
  const doc = await PDFDocument.create();
  doc.setTitle('Quarterly Report');
  doc.setAuthor('Test Author');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Quarterly Report ${i}`, { x: 72, y: 700, size: 24, font: bold });
    p.drawText('The quick brown fox jumps over the lazy dog.', { x: 72, y: 650, size: 12, font });
    p.drawText('Account SECRET-123 is closed.', { x: 72, y: 630, size: 12, font });
    p.drawText(`Page ${i}`, { x: 290, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  }
  return doc.save();
}

async function form() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  p.drawText('Full name:', { x: 72, y: 700, size: 12, font });
  const f = doc.getForm();
  const name = f.createTextField('FullName');
  name.addToPage(p, { x: 160, y: 690, width: 250, height: 22 });
  p.drawText('I agree:', { x: 72, y: 650, size: 12, font });
  f.createCheckBox('Agree').addToPage(p, { x: 160, y: 645, width: 16, height: 16 });
  return doc.save();
}

/** A page that is only a picture of text, like a scan. */
async function scan(png: Uint8Array) {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const img = await doc.embedPng(png);
  p.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  return doc.save();
}

export default async function setup() {
  fs.mkdirSync(DATA, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const draw = (w: number, h: number, lines: string[], size: number, bg: string) => page.evaluate(([w, h, lines, size, bg]) => {
    const c = document.createElement('canvas');
    c.width = w as number; c.height = h as number;
    const g = c.getContext('2d')!;
    g.fillStyle = bg as string; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111'; g.font = `${size}px Arial`;
    (lines as string[]).forEach((l, i) => g.fillText(l, 150, 300 + i * (size as number) * 1.6));
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h, lines, size, bg] as const);
  const scanPng = Buffer.from(await draw(1700, 2200, ['INVOICE NUMBER 4471', 'Total amount due 920 dollars', 'Thank you for your business'], 64, '#fdfdf8'), 'base64');
  const photo = Buffer.from(await draw(800, 600, ['Photo'], 80, '#8ac'), 'base64');
  await browser.close();

  const r = await report();
  const write = (name: string, bytes: Uint8Array | Buffer | string) => fs.writeFileSync(path.join(DATA, name), bytes);
  write('report.pdf', r);
  write('Résumé 📄 تقرير.pdf', r);
  write(`${'long-name-'.repeat(20)}.pdf`, r);
  write('form.pdf', await form());
  write('scan.pdf', await scan(scanPng));
  write('photo.png', photo);
  write('not-a-pdf.pdf', 'this is plain text, not a PDF');
  write('empty.pdf', '');
  // Damaged the usual ways: cross-reference table and trailer lost, or the offsets in them wrong.
  const plain = Buffer.from(await (await PDFDocument.load(r)).save({ useObjectStreams: false }));
  const xref = plain.lastIndexOf('xref');
  write('damaged.pdf', plain.subarray(0, xref));
  write('bad-offsets.pdf', Buffer.from(plain.toString('latin1').replace(/(\d{10}) 00000 n/g, (_, n) => `${String(Number(n) + 7).padStart(10, '0')} 00000 n`), 'latin1'));
}
