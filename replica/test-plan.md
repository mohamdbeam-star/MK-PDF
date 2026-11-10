# Test plan: MK PDF (shared app: Windows, Android, iPhone)

Build: 8bf16ff + working-tree fixes  Date: 2026-11-05  Env: local Vite dev server (browser build of the shared app), Chromium 156, generated test files

There was no `replica/recon.md`: MK PDF is our own app, not a clone, so the flows below come from its own
screens (Home, document toolbar, the eleven tool panels and the dialogs). The Mac app is separate Swift code and
is not covered here.

Test files are generated on every run by `cross/e2e/setup.ts` into `cross/e2e/.data` (ignored by git): a 3-page
report, a form with a text field and a checkbox, an image-only "scan", a photo, an empty file, a text file named
`.pdf`, names with accents/emoji/Arabic and a 200-character name, a locked copy made by the app, and two damaged
files (cross-reference table cut off; offsets wrong).

Run: `cd cross && npm run e2e` (starts the dev server itself). Every spec fails on console errors, uncaught page
errors and 5xx responses; the release check to GitHub is answered locally so tests never reach it.

## Flows

| flow | what |
| --- | --- |
| F01 | open a PDF (Home, + tab, Ctrl+O, drag and drop) |
| F02 | create blank, combine files, images to PDF |
| F03 | view and navigate (pages, zoom, search, read mode) |
| F04 | edit existing text in place |
| F05 | comment and mark up |
| F06 | organize pages |
| F07 | fill forms and sign |
| F08 | redact |
| F09 | password protect |
| F10 | recognize text in scans |
| F11 | export and compress |
| F12 | save, tabs, closing |
| F14 | find and replace across the document |
| F15 | reading view (reflowed for phones) |
| F13 | repair, compare, watermark, header and footer |
| A11Y | axe scan of seven screens (serious and critical issues fail) |

## Cases

| case | flow | type | steps | expected | auto | result |
| --- | --- | --- | --- | --- | --- | --- |
| F01-H1 | F01 | happy | Home › Open › report.pdf | 3 pages render, tab "report.pdf", listed under Recent | e2e | pass |
| F01-H2 | F01 | happy | drop a PDF on the window | opens as a tab | e2e | pass |
| F01-E1 | F01 | edge: empty file | open a 0-byte .pdf | "Couldn't open …" message, stays on Home | e2e | pass |
| F01-N1 | F01 | negative: not a PDF | open a text file named .pdf | refused with a message | e2e | pass |
| F01-E2 | F01 | edge: accents, emoji, Arabic | open "Résumé 📄 تقرير.pdf" | name shown intact | e2e | pass |
| F01-E3 | F01 | edge: very long input | open a 200-character file name | tab stays under 400 px, Save still on screen | e2e | pass |
| F01-E4 | F01 | edge: several at once | pick two files | two tabs | e2e | pass |
| F01-E5 | F01 | edge: double click | double-click Open | one picker | manual | to check (see bugs.md) |
| F01-E6 | F01 | edge: refresh mid-flow | reload with a document open | back to Home, no errors | e2e | pass |
| F01-E7 | F01 | edge: mobile width | Pixel 7 viewport | Home fits, opening works | e2e | pass |
| F01-E8 | F01 | edge: keyboard only | Ctrl+O | picker opens, file opens | e2e | pass |
| F02-H1 | F02 | happy | Create Blank, Save | one-page PDF saved | e2e | pass |
| F02-H2 | F02 | happy | Combine report.pdf + form.pdf | 4 pages in order | e2e | pass |
| F02-H3 | F02 | happy | Images to PDF with two photos | 2 pages | e2e | pass |
| F02-E1 | F02 | edge: cancel | Combine, cancel the picker | nothing happens | e2e | pass |
| F03-H1 | F03 | happy | next, previous, type a page number | moves; Next disabled on the last page | e2e | pass |
| F03-E1 | F03 | edge: bad input | type 0, 99, abc into the page box | stays on a real page number | e2e | pass after BUG-006 fix |
| F03-H2 | F03 | happy | zoom in | zoom level changes | e2e | pass |
| F03-H3 | F03 | happy | Ctrl+F, type SECRET-123 | search box focused, results listed | e2e | pass after BUG-007 fix |
| F03-E2 | F03 | edge: emoji, no match | search "🦊 nothing here" | no results, no errors | e2e | pass |
| F03-H4 | F03 | happy | More Tools › Read mode, Escape | chrome hidden, then back | e2e | pass |
| F03-E3 | F03 | edge: mobile width | phone viewport with a document | no sideways scroll, Save on screen | e2e | pass after BUG-005 fix |
| F04-H1 | F04 | happy | Edit Text & Images, tap the sentence, retype, Done, Save | new text in the file, old text gone, other pages untouched | e2e | pass |
| F04-E1 | F04 | edge: accents and Arabic | type "Café déjà vu مرحبا" | saved text reads back exactly | e2e | pass after BUG-002 fix |
| F04-E2 | F04 | edge: very long input | 120 words into one paragraph | all 120 words saved | e2e | pass |
| F04-E3 | F04 | edge: empty input | delete all text, Done | paragraph removed | e2e | pass |
| F04-E4 | F04 | edge: cancel | type, press ✕ | page unchanged, not marked unsaved | e2e | pass |
| F04-H2 | F04 | happy | edit, Undo button, Redo button | buttons enabled; file follows | e2e | pass after BUG-003 fix |
| F04-E5 | F04 | edge: re-edit | edit the same paragraph twice | editor shows the first edit; second replaces it | e2e | pass |
| F04-E6 | F04 | happy | A+ and B on the style bar | size goes up by 1 | e2e | pass |
| F04-E7 | F04 | edge: mobile width | edit a paragraph on a phone | edit saved | e2e | pass |
| F04-H3 | F04 | happy | edit a paragraph set in an embedded font MK PDF doesn't bundle | new text written in that font; no substitute font added | e2e | pass |
| F04-E8 | F04 | edge: letters missing from the subset | type "Zebra 42! Ψ" into it | falls back to a full font, text intact | e2e | pass |
| F04-H4 | F04 | happy | drag a paragraph's width handle to a third | text reflows onto more lines, every word kept | e2e | pass |
| F04-E9 | F04 | edge: Shift while moving | Shift-drag a paragraph diagonally | moves sideways only, same baseline | e2e | pass |
| F04-H5 | F04 | happy | justify a long edit | all lines but the last end at one right edge; words in order | e2e | pass |
| F04-E10 | F04 | happy | underline | one rule added under the text | e2e | pass |
| F04-E11 | F04 | happy | line spacing ×2 | gap between baselines doubles | e2e | pass |
| F04-E12 | F04 | happy | font menu: Courier New | edit written in a Courier or mono font | e2e | pass |
| F04-H6 | F04 | happy | three lines as a bulleted list | a bullet before each, text indented | e2e | pass |
| F04-E13 | F04 | edge: number already typed | "1. First", Second, Third as a numbered list | 1., 2., 3., never "1. 1." | e2e | pass |
| F04-E14 | F04 | happy | +12 pt after paragraphs | gap grows by 12 pt | e2e | pass |
| F04-E15 | F04 | happy | letters wider (+6%) and width 120% | text widens by the expected amount and still reads as words | e2e | pass |
| F04-E16 | F04 | happy | select the 2 in m2 and in H2O; Superscript, Subscript | saved text reads m² and H₂O | e2e | pass |
| F04-N1 | F04 | negative: no raised form | select TM, Superscript | message, text unchanged | e2e | pass |
| F05-H1 | F05 | happy | sticky note, text box, rectangle, drawing | four annotations on page 1, none on page 2 | e2e | pass |
| F05-H2 | F05 | happy | Highlight tool, drag over a sentence | Highlight annotation | e2e | pass |
| F05-N1 | F05 | negative: cancel | sticky note, Cancel | nothing added | e2e | pass |
| F05-H3 | F05 | happy | select a note, Delete key, Ctrl+Z | removed, then back | e2e | pass |
| F05-E1 | F05 | edge: accidental tap | tiny rectangle drag | nothing added | e2e | pass |
| F06-H1 | F06 | happy | rotate right, duplicate, insert blank, delete | rotation 90, 5 pages, then 4 | e2e | pass |
| F06-H2 | F06 | happy | reverse page order | pages 3, 2, 1 | e2e | pass |
| F06-H3 | F06 | happy | extract 2-3 | new 2-page document | e2e | pass |
| F06-N1 | F06 | negative: bad range | extract "7-9, abc" | nothing opened | e2e | pass |
| F06-E1 | F06 | edge: delete everything | delete all three pages | refused at the last page with a message | e2e | pass |
| F07-H1 | F07 | happy | click the text field, type "Zoë Ångström محمد", click the checkbox | values saved in the form | e2e | pass after BUG-001 fix |
| F07-H2 | F07 | happy | draw a signature, Save and place, tap the page | Stamp annotation saved | e2e | pass |
| F07-H3 | F07 | happy | Prepare Form › Text Field, drag | one field in the file | e2e | pass |
| F07-H4 | F07 | happy | fill, Flatten form fields | no fields left, value is page text | e2e | pass |
| F08-H1 | F08 | happy | Redact › mark SECRET-123 › Apply | gone from all 3 pages, rest of the text kept | e2e | pass |
| F08-N1 | F08 | negative: no match | mark "nowhere-🦊" | "No matches" | e2e | pass |
| F08-H2 | F08 | happy | Remove metadata | title and author empty | e2e | pass |
| F09-H1 | F09 | happy | password "s3cret pässword", Save, reopen | file needs the password; wrong one refused; right one opens | e2e | pass |
| F09-N1 | F09 | negative: mismatch | different confirm password | "Passwords don't match" | e2e | pass |
| F10-H1 | F10 | happy | Scan & OCR › Recognize text on the scan | "INVOICE … 4471" searchable | e2e | pass |
| F10-H2 | F10 | happy | edit mode on a scan › Make This Page Editable | paragraphs become editable | e2e | pass |
| F10-H3 | F10 | happy | recognise a scan with a worn word | review sheet shows the word's picture; correction saved | e2e | pass |
| F10-E1 | F10 | edge: clean scan | recognise | nothing to review | e2e | pass |
| F10-H4 | F10 | happy | recognise a scan tilted 4° on yellowed paper | page straightened (<1.5 px climb) and whitened, text read | e2e | pass |
| F10-E2 | F10 | edge: clean-up off | recognise with the option off | page unchanged | e2e | pass |
| F11-H1 | F11 | happy | Export › Word (.docx) | all text, headings in page headers | e2e | pass |
| F11-H2 | F11 | happy | every document format | each a non-empty file | e2e | pass |
| F11-H3 | F11 | happy | PNG page images | report-1/2/3.png | e2e | pass |
| F11-H4 | F11 | happy | Word export of a scan with recognition | real text in the .docx | e2e | pass |
| F11-H5 | F11 | happy | Compress | valid 1-page file | e2e | pass |
| F11-H6 | F11 | happy | Word export as flowing text | one section, no fixed line heights, every page title kept, Heading styles, page-number field | e2e | pass |
| F11-H7 | F11 | happy | Export › Selected area around one sentence › Word | only that sentence in the file | e2e | pass |
| F11-H8 | F11 | happy | same area › CSV | only that sentence | e2e | pass |
| F11-N1 | F11 | negative: empty area | box over blank paper | "No text or tables in that area" | e2e | pass |
| F11-H9 | F11 | happy | Word export with Include pictures off, then on | no media without; media with; text kept | e2e | pass |
| F11-H10 | F11 | happy | extract images, then skip under 100 px | 2 files, then 1 | e2e | pass |
| F11-H11 | F11 | happy | Word export of a page with a sticky note and a reply | one Word comment, author and date kept, reply folded in, on the nearest paragraph | e2e | pass |
| F11-E3 | F11 | edge: comments off | Include comments unchecked | no comments part | e2e | pass |
| F12-H1 | F12 | happy | change, Save | same name, unsaved dot cleared | e2e | pass |
| F12-E1 | F12 | edge: close unsaved | close, decline, close, accept | kept, then closed | e2e | pass |
| F12-E2 | F12 | edge: two documents | change one, check the other | other untouched | e2e | pass |
| F12-E3 | F12 | edge: double click on submit | double-click Save | one file written | e2e | pass after BUG-010 fix |
| F12-E4 | F12 | edge: keyboard only | Ctrl+Tab, Ctrl+W | switches, closes | e2e | pass |
| F13-H1 | F13 | happy | Repair the two damaged files | 3-page file with all text | e2e | pass after BUG-004 fix |
| F13-H2 | F13 | happy | Compare report.pdf with form.pdf | differences listed, Done closes | e2e | pass |
| F13-H3 | F13 | happy | Watermark "CONFIDENTIAL" | on every page | e2e | pass |
| F13-H4 | F13 | happy | Header & footer | saves | e2e | pass |
| F14-H1 | F14 | happy | replace SECRET-123 with "ACCT-9 é" | 3 matches replaced on 3 pages, other text untouched | e2e | pass |
| F14-H2 | F14 | happy | replace, then Undo once | every page back | e2e | pass |
| F14-E1 | F14 | edge: whole words | "quic" finds nothing; "the" replaces 6 | partial words left alone | e2e | pass |
| F14-E2 | F14 | edge: match case | replace "the" | "The" kept | e2e | pass |
| F14-N1 | F14 | negative: no match | "nowhere 🦊" | message, no change, nothing to undo | e2e | pass |
| F14-E3 | F14 | edge: embedded font | replace inside the Georgia paragraph | stays in the document's font | e2e | pass |
| F15-H1 | F15 | happy | open Reading view (desktop and phone) | 3 headings, paragraphs, no page numbers, contents jumps, Escape closes, no sideways scroll | e2e | pass |
| F15-H2 | F15 | happy | larger text, line spacing, reopen | size and spacing change and are remembered | e2e | pass |
| F15-E1 | F15 | edge: scan without text | open Reading view | explains to recognise text first | e2e | pass |
| A11Y S01–S07 | all | edge: screen reader labels, contrast | axe scan per screen | no serious or critical issues | e2e | pass after BUG-008/009 fixes |

## Edge cases that don't apply

No accounts, servers or payments: expired session, wrong password at sign-in, second user's data, declined card
and 5xx from our own API have nothing to act on. Offline: everything works locally except the update check
(answered locally in tests). Slow network only affects the first load of fonts and the OCR language data.
Time zones: only the Date stamp uses the clock (local date, by design).

## Manual pass (needs the real shells; not run here)

- Windows (Electron): Save As dialog, saving over the open file, reopening from Recent, Print, Check for updates.
- Android: system file picker, Scan with camera, Share, Save to Documents/MK PDF, update install.
- iPhone: document picker, "Show" in the Files app toast, Share, translation, update notification.
- Read aloud on each platform.
