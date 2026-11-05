# Bugs: MK PDF shared app (Windows, Android, iPhone)

Found by the end-to-end suite in `cross/e2e` (see `test-plan.md`). Every bug below was reproduced; each has a
test that failed before the fix and passes after it. Fixes are in the working tree, not committed yet.

| id | severity | title | status |
| --- | --- | --- | --- |
| BUG-001 | S1 | Form fields can't be clicked or tapped | fixed, not committed |
| BUG-002 | S2 | Edited Arabic text copies and searches with a junk character | fixed, not committed |
| BUG-003 | S2 | Undo and Redo buttons stay greyed out after an edit | fixed, not committed |
| BUG-004 | S2 | Repair PDF fails on the usual kinds of damage | fixed, not committed |
| BUG-005 | S3 | Save, Undo and Redo are off-screen on phones | fixed, not committed |
| BUG-006 | S3 | Page number box accepts 0 and letters, then the arrows stop working | fixed, not committed |
| BUG-007 | S3 | Ctrl+F does nothing unless Search is already open | fixed, not committed |
| BUG-008 | S3 | Screen readers can't name several controls | fixed, not committed |
| BUG-009 | S4 | Low contrast on grey hint text and stamp buttons | fixed, not committed |
| BUG-010 | S4 | Double-clicking Save writes the file twice | fixed, not committed |
| BUG-011 | S4 | Uncaught errors in the console after edits and repairs | fixed, not committed |

### BUG-001: Form fields can't be clicked or tapped

- Severity: S1 (core flow blocked: filling a form with a mouse or a finger)
- Flow / case: F07 / F07-H1
- Screen: document, Select tool (the default), any panel except Prepare Form
- Build: 8bf16ff  Browser / device: Chromium 156, 1440 px

Steps
1. Open form.pdf (a text field and a checkbox).
2. Click inside the text field and type; click the checkbox.

Expected: the field takes the typing; the checkbox ticks.
Actual: nothing happens. An invisible selection box (`.mk-hit`, used to move fields while preparing a form) sits on
top of every field, so the click lands on it instead. Keyboard Tab still reaches the fields; phones have no
workaround.
Evidence: `elementFromPoint` at the checkbox centre returned `<div class="mk-hit" title="Widget">`; F07-H1 timed out.
Cause: `Overlay.tsx` gave form fields selection boxes whenever the Select tool was on.
Fix: the boxes appear only while the Prepare Form panel is open.
Status: fixed in the working tree, not committed.

### BUG-002: Edited Arabic text copies and searches with a junk character

- Severity: S2 (search and copy of edited Arabic text broken, no workaround)
- Flow / case: F04 / F04-E1
- Screen: edit mode

Steps
1. Edit a paragraph and type "مرحبا" (any word with ب, ت, ث, ن or ي).
2. Save; search the saved file for "مرحبا", or copy the text.

Expected: the word is found and copies as typed.
Actual: the text reads "مرحب" + U+0002 + "ا", so search fails and pasted text has a control character. The page
looks right.
Evidence: code points of the saved text: `645 631 62d 628 2 627`. Reproduced outside the app with pdf-lib and the
bundled Noto Naskh Arabic.
Cause: the font draws ب as a dotless shape plus a separate dot glyph that stands for no character. pdf-lib maps
that glyph to nothing, and readers then put the glyph's code in the text.
Fix: `engine/load.ts` maps such glyphs to a zero-width joiner when the font's character map is written; pdf.js and
other readers drop it (checked: extraction gives `645 631 62d 628 627`).
Status: fixed in the working tree, not committed. Files saved before the fix keep the junk character.

### BUG-003: Undo and Redo buttons stay greyed out after an edit

- Severity: S2 (no undo button after any change; phones have no Ctrl+Z)
- Flow / case: F04 / F04-H2

Steps
1. Open report.pdf, change a paragraph, press Done.
2. Look at the Undo button.

Expected: Undo is enabled ("Undo Edit Text").
Actual: Undo stays disabled until something unrelated redraws the toolbar. Ctrl+Z works.
Evidence: the tab shows "● report.pdf" while the button's title is plain "Undo" and it is disabled.
Cause: the toolbar read the undo state from a plain getter and never re-rendered when the document changed.
Fix: the toolbar follows the document's version, so it redraws after every edit, undo and redo.
Status: fixed in the working tree, not committed.

### BUG-004: Repair PDF fails on the usual kinds of damage

- Severity: S2 (the Repair feature fails on exactly the files it exists for)

Steps
1. Home › Repair PDF › pick a file whose cross-reference table is cut off (an interrupted download), or one whose
   table points at the wrong offsets.

Expected: a repaired copy opens.
Actual: "Repairing failed: qpdf failed (2)".
Evidence: qpdf's messages: "can't find startxref" and "(object 2 0, offset 96): expected n n obj"; F13-H1 for both files.
Fix: when qpdf gives up, the objects are read in file order with pdf-lib and written out with a fresh table. qpdf's
own message now becomes the error text instead of "qpdf failed (2)", for example when a file is too damaged to
recover.
Status: fixed in the working tree, not committed.

### BUG-005: Save, Undo and Redo are off-screen on phones

- Severity: S3 (reachable only by swiping the toolbar, which shows no sign that it scrolls)
- Flow / case: F03 / F03-E3
- Browser / device: Pixel 7 and iPhone 13 viewports

Expected: Save and Undo visible with a document open.
Actual: the toolbar's right end, with Undo, Redo, Organize, Save and All tools, sat past the screen edge.
Evidence: F03-E3 failed with "viewport ratio 0" for Save; after the fix see `replica/evidence/phone-toolbar-after.png`.
Fix: on narrow screens the quick tools scroll sideways between the page number and Undo/Redo/Save. The previous and
next arrows, Organize and All tools are hidden there; the page box, the page swipe, the Tools button and the
Organize panel cover them.
Status: fixed in the working tree, not committed.

### BUG-006: Page number box accepts 0 and letters, then the arrows stop working

- Severity: S3
- Flow / case: F03 / F03-E1

Steps
1. Type `abc` in the page number box and press Enter.

Expected: the box goes back to the current page number.
Actual: the box shows "NaN", the console logs `scrollPageIntoView: "NaN" is not a valid pageNumber`, and Previous
and Next then do nothing. Typing `0` leaves "0" in the box.
Fix: only whole numbers of 1 or more are used (above the last page goes to the last page); the box always shows the
real page afterwards. It also has a label and a numeric keyboard on phones.
Status: fixed in the working tree, not committed.

### BUG-007: Ctrl+F does nothing unless Search is already open

- Severity: S3 (workaround: click the search icon in the sidebar)
- Flow / case: F03 / F03-H3

Steps
1. Open a document (sidebar on Pages), press Ctrl+F or Cmd+F.

Expected: the search box opens with the cursor in it.
Actual: nothing; focus stays on the page.
Fix: the shortcut switches the sidebar to Search, shows it, and focuses the box.
Status: fixed in the working tree, not committed.

### BUG-008: Screen readers can't name several controls

- Severity: S3
- Flow / case: A11Y S02–S07 (axe "critical")

Unnamed controls: the page number box, the eight colour swatches, the colour picker, the thumbnail size slider, the
text style bar (✕ and the align buttons), and the inline text editor. Prompts (sticky note, passwords, page
ranges) were not announced as dialogs. The sidebar mode buttons were named "thumbs", "outline" and so on.
Fix: labels and pressed states added; prompts and choices are dialogs named by their title; the sidebar buttons
read Pages, Bookmarks, Comments, Search.
Status: fixed in the working tree, not committed.

### BUG-009: Low contrast on grey hint text and stamp buttons

- Severity: S4
- Flow / case: A11Y S01, S04 (axe "serious" colour-contrast)

Grey hint text (#6b6b78) on the light glass background and the green and teal stamp labels were below 4.5:1.
Fix: grey darkened to #5b5b68; stamp button labels drawn darker. The stamps on the page keep their colour.
Status: fixed in the working tree, not committed.

### BUG-010: Double-clicking Save writes the file twice

- Severity: S4
- Flow / case: F12 / F12-E3

Actual (browser build): "report.pdf" and "report (1).pdf" downloaded. A double click on phones writes the same file twice.
Fix: a second Save within 0.6 s, or while a save is running, is ignored.
Status: fixed in the working tree, not committed.

### BUG-011: Uncaught errors in the console after edits and repairs

- Severity: S4 (nothing visible, but it hides real errors)
- Flow / case: F06-H2, F12-H1, F13-H1 (console guard)

Actual: `RenderingCancelledException` uncaught three times after reversing pages, because thumbnail renders are
cancelled when the document changes. qpdf also printed its warnings straight to the console.
Fix: cancelled thumbnails are dropped quietly and redrawn for the new version; qpdf's messages are collected for the
error text.
Status: fixed in the working tree, not committed.

## To check (seen once or not reproducible here; not counted as bugs)

- Double-clicking Open opened two file pickers in headless Chromium. In a real browser the first picker is modal.
  Check on Windows, where the native dialog might open twice.
- Opening several files at once: each tab takes focus as it finishes loading. If you click the first tab while the
  second is still loading, focus jumps to the second, and your next action applies there.
- After tapping a paragraph, the editor takes about 0.3 s to fill (it waits for the font). Typing in that moment
  is lost.
- Word export moves text that repeats on every page into the Word page header and footer. The report's headings
  ("Quarterly Report 1/2/3", differing only by number) went there instead of the body. That's right for running
  titles, but could surprise someone whose page headings follow a numbered pattern.
- Compare from Home opens the second file picker without a new tap. Chromium allows it; check that the Android web
  view does too.
- Deleting the last page is refused with "A PDF needs at least one page". Fine, but the Delete button could be
  disabled instead.
- Not covered at all: the Mac app (separate Swift code). BUG-001, BUG-003 and BUG-007 may or may not apply there.
