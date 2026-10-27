# MK PDF

An app for viewing, editing, signing, organizing and converting PDFs, for **Mac, Windows and Android**. You can **edit the real text and images in a PDF**, not just draw on top of it, including scanned pages.

- **Mac:** native SwiftUI app with PDFKit, Vision and Core Text, plus its own PDF content engine (`Sources`).
- **Windows and Android:** the same features in a shared app (`cross/`), wrapped by Electron on Windows and Capacitor on Android.
- **Conversions** (Word, Excel, PowerPoint, HTML, Markdown, text, CSV, RTF) use one engine on every platform (`cross/src/core`); the Mac app runs it in JavaScriptCore.

## Editing existing content (Edit PDF → Edit Text & Images, ⇧⌘E)

- **Change text in place.** Click any paragraph to retype it. MK PDF removes the original glyphs from the page's content stream and draws the new text with the same font, size, color and line spacing. It reflows multi-line paragraphs, handles right-to-left text such as Arabic, and keeps the rest of the page exactly where it was.
- **Restyle.** Change the font, size, bold or italic, alignment and color while editing.
- **Move text.** Drag a paragraph to a new position.
- **Add text.** Double-click empty space, or use *Add New Text…*, to add real page text rather than an annotation.
- **Images and drawings.** Drag to move, drag the corner to resize, press Delete to remove, *Replace image…* to swap in a new one, and *Save as PNG…* to export one.
- **Fonts.** MK PDF uses the installed original font first, then fonts bundled with Microsoft Office (Calibri, Cambria, …), then the PDF's own embedded font if it contains every character you typed, and finally the closest system family.

- **Scanned pages and drawings.** Pages with no real text show *Make This Page Editable*. Offline OCR recognizes the text; editing a line then paints over the old pixels in the paper colour and writes the new text in the ink colour.

How it works: `Sources/MKPDFCore` parses each page's content stream and tracks the graphics and text state so every glyph and image has a position. Each glyph's text is read from its font (the ToUnicode map, else the encoding and glyph names), so tables and other text that PDFKit places off its glyphs are still found; PDFKit is used only for right-to-left text and fonts that don't say what their codes mean. It rewrites text-showing operators glyph by glyph, keeping the spacing of what remains. It then writes a new page that reuses the original fonts, images and other resources, so nothing is rasterized.

## Everything else

| Area | Features |
| --- | --- |
| Tabs | Opening several PDFs puts them in one window as tabs |
| View | Continuous / single / two-page layouts, zoom & fit, page thumbnails, bookmarks, search with results list, night mode, read mode, read aloud |
| Comment | Highlight, underline, strikethrough, sticky notes, text boxes, freehand drawing, rectangles, ovals, lines, arrows, 12 stamps (optionally with name and date), comment list, comment summary export, flatten |
| Fill & Sign | Fill form fields, add text / ✓ / ✗ / ● / date anywhere, draw, type or import signatures and initials (saved for reuse), finalize |
| Organize | Drag-and-drop page grid, rotate, delete, insert blank or from file, duplicate, replace, extract, split (by pages, ranges, file count or bookmarks), reverse, crop |
| Edit PDF | Text & image editing (above), whiteout, links to URLs or pages, watermarks, headers & footers with page numbers, Bates numbering, crop |
| Prepare Form | Create text fields, checkboxes and dropdowns; rename; clear; flatten |
| Redact | Mark areas or text, find-and-redact (whole words), apply. Text-only redactions remove the exact glyphs and keep the page vector and searchable; pages where an image is partly covered are flattened, with optional OCR afterwards. Remove metadata. |
| Protect | Password to open, permission restrictions (print, copy, edit, comment, forms) |
| Scan & OCR | On-device text recognition (Vision) adds an invisible text layer so scans become searchable and selectable |
| Compress | Four presets, from re-encoding images only up to fully flattening pages to images, with a before/after size check |
| Export | Rebuilt from each page's layout (paragraphs, fonts, colours, alignment, RTL, tables, images): Word (.docx/.doc), PowerPoint (editable text over the page artwork), Excel, HTML (exact layout, selectable text), RTF, OpenDocument, Markdown, text, CSV; PNG / JPEG / HEIC / WebP / TIFF / BMP / GIF pages; flattened, grayscale and PDF/X-3 |
| Create | Blank, combine files, images to PDF, Word/RTF/HTML/text to PDF, web page to PDF, clipboard to PDF |
| Compare | Side-by-side view with a word-level change list |
| AI Assistant | Mac only: summaries and questions answered on-device with Apple Intelligence, with a text-search fallback when Apple Intelligence is off. Not on Windows/Android, which have no free on-device model that runs well on typical hardware. |
| Batch | Run one tool on many PDFs: compress, OCR, page numbers, watermark, password, rotate, flatten, remove metadata, convert to JPG / Word / Excel / text |
| Convert | Excel (tables become rows and columns) and PowerPoint (one slide per page), with optional OCR for scanned pages; extract embedded images (JPEGs saved unchanged) |
| Repair | Rebuild every page of a damaged PDF through the content engine |
| More | Split by file size or merge chosen ranges, image watermarks, place a signature or stamp on every page / all but last / a range, visual overlay compare, translate on-device, scan with iPhone (Continuity Camera), right-to-left two-page reading, arrow-key nudging, light/dark appearance, notifications when long tasks finish |
| Updates | Checks GitHub Releases at launch, every hour and whenever the app comes to the front; shows a banner and a notification. *Download & Install* replaces the app in place and restarts it (Mac: swaps the app bundle; Windows: silent per-user installer; Android: the system installer updates over the current app) |
| Other | Full undo/redo, document properties, print, share |

## Install

From [Releases](https://github.com/mohamdbeam-star/MK-PDF/releases):

- **Mac:** `MK-PDF-x.y.z.dmg`. Open it and drag **MK PDF** into Applications. The build is ad-hoc signed, so the first time, right-click the app and choose **Open**.
- **Windows:** `MK-PDF-x.y.z-win-x64.exe` installs for the current user only, with no administrator rights. `MK-PDF-x.y.z-portable.exe` runs without installing. SmartScreen may warn about an unsigned app: choose **More info → Run anyway**.
- **Android:** `MK-PDF-x.y.z-android.apk`. Open it on the phone; Android asks once to allow installs from your browser or files app.

Every copy checks for a newer release at launch, every hour and when it comes to the front, and installs it over itself: nothing to uninstall. On Android the first update asks once to allow MK PDF to install apps.

## Release (no Mac needed)

Everything is built on GitHub's machines by `.github/workflows/release.yml`:

```bash
echo 1.3.0 > VERSION          # then write RELEASE_NOTES.md, commit and push
git tag v1.3.0 && git push origin v1.3.0
```

The workflow builds the Mac DMG (Apple Silicon + Intel), the Windows installer and portable app, and the Android APK. It tests each one and publishes them together as release `v1.3.0`; you can also start it from **Actions → Release → Run workflow**. `.github/workflows/ci.yml` runs the tests on every push.

### Android signing (one time)

Run `scripts/android-signing-key.sh` once on any Mac with `gh` signed in. It creates a permanent signing key in `~/Documents/MKPDF-keys` and stores it as the repository's `ANDROID_*` secrets. Until then, releases are signed with a temporary key, and installing a newer APK requires uninstalling the old one first.

## Build locally

**Mac** (macOS 15+, Xcode or the Command Line Tools, Node 22):

```bash
./build_app.sh          # builds "MK PDF.app" next to the script (including the conversion engine)
open "MK PDF.app"
```

`UNIVERSAL=1 ./build_app.sh` builds for both Apple Silicon and Intel. Set `SIGN_IDENTITY` to a Developer ID certificate for a signed build.

**Windows / Android / browser** (`cross/`, Node 22):

```bash
cd cross && npm ci
npm run dev             # in a browser
npm run electron        # the Windows shell (also runs on Mac/Linux)
npm run dist:win        # Windows installer + portable exe (on Windows)
npm run android:sync    # copy the app into cross/android, then build with Gradle or Android Studio
```

## Tests

```bash
cd cross && npm test                       # shared engine: content streams, layout, right-to-left text
npx tsx scripts/export.mts in.pdf out.docx # convert with the shared engine (any format by extension)
swift run MKPDFSelfTest                    # content engine checks
swift run MKPDFSelfTest some.pdf other.pdf # round-trip and word removal on your own files
swift build --product MKPDF && .build/debug/MKPDF --edit-smoke-test in.pdf out.pdf
.build/debug/MKPDF --edit-coverage a.pdf b.pdf   # share of each file's text offered as editable blocks
.build/debug/MKPDF --edit-blocks in.pdf 3        # the editable blocks found on page 3
.build/debug/MKPDF --feature-smoke-test in.pdf outdir   # Excel, PowerPoint, images, every batch tool, update logic
.build/debug/MKPDF --scan-edit-smoke-test scan.pdf out.pdf "old words" "new words"  # OCR, edit and repaint a scan
```

The self-test checks the parser, the page rewriter (each rewritten page must render identically and keep identical text), glyph-exact text removal that leaves the surrounding text in place, and image move, resize and delete. The edit smoke test runs the app's editing pipeline headlessly on a file.

## Known limits

- Text inside form XObjects, and text that is rotated or vertical, can't be edited in place yet. Use *Cover and retype selected text* for those.
- Edited scanned text uses Helvetica by default (recognition can't tell the original font); pick another in the edit panel.
- Certificate-based digital signatures, PDF/A conversion and Excel/PowerPoint → PDF need a commercial PDF engine and aren't included.
- Type0 fonts are assumed to use 2-byte codes (Identity-H, by far the most common encoding).
