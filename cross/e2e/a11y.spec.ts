// Accessibility scan of each screen with axe: reported per screen, serious and critical issues fail.
import AxeBuilder from '@axe-core/playwright';
import { test, expect, openDoc, start, panel } from './helpers';
import fs from 'node:fs';

const SCREENS: [string, (p: import('@playwright/test').Page) => Promise<void>][] = [
  ['S01 Home', async (p) => { await start(p); }],
  ['S02 Document', async (p) => { await openDoc(p, 'report.pdf', 3); }],
  ['S03 Edit mode', async (p) => { await openDoc(p, 'report.pdf', 3); await p.getByRole('button', { name: 'Edit Text & Images' }).first().click(); }],
  ['S04 Comment panel', async (p) => { await openDoc(p, 'report.pdf', 3); await panel(p, 'Comment'); }],
  ['S05 Protect panel', async (p) => { await openDoc(p, 'report.pdf', 3); await panel(p, 'Protect'); }],
  ['S06 Export panel', async (p) => { await openDoc(p, 'report.pdf', 3); await panel(p, 'Export'); }],
  ['S07 Organize grid', async (p) => { await openDoc(p, 'report.pdf', 3); await p.getByTitle('Organize pages').click(); }],
];

for (const [name, go] of SCREENS) {
  test(`A11Y ${name}`, async ({ page, errors }) => {
    await go(page);
    const r = await new AxeBuilder({ page }).exclude('.pdfViewer canvas').analyze();
    fs.mkdirSync('e2e/.out/axe', { recursive: true });
    fs.writeFileSync(`e2e/.out/axe/${name.split(' ')[0]}.json`, JSON.stringify(r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)) })), null, 1));
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
  });
}
