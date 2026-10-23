# MK PDF

A native macOS app for viewing, editing, signing, organizing and converting PDFs. It's built with SwiftUI, PDFKit, Vision and Core Text, plus its own PDF content engine that rewrites page content so you can **edit the real text and images in a PDF**, not just draw on top of it.

## Editing existing content (Edit PDF → Edit Text & Images, ⇧⌘E)

- **Change text in place.** Click any paragraph to retype it. MK PDF removes the original glyphs from the page's content stream and draws the new text with the same font, size, color and line spacing. It reflows multi-line paragraphs, handles right-to-left text such as Arabic, and keeps the rest of the page exactly where it was.
- **Restyle.** Change the font, size, bold or italic, alignment and color while editing.
- **Move text.** Drag a paragraph to a new position.
- **Add text.** Double-click empty space, or use *Add New Text…*, to add real page text rather than an annotation.
- **Images and drawings.** Drag to move, drag the corner to resize, press Delete to remove, *Replace image…* to swap in a new one, and *Save as PNG…* to export one.
- **Fonts.** MK PDF uses the installed original font first, then fonts bundled with Microsoft Office (Calibri, Cambria, …), then the PDF's own embedded font if it contains every character you typed, and finally the closest system family.

How it works: `Sources/MKPDFCore` parses each page's content stream and tracks the graphics and text state so every glyph and image has a position. It rewrites text-showing operators glyph by glyph, keeping the spacing of what remains. It then writes a new page that reuses the original fonts, images and other resources, so nothing is rasterized.

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
| AI Assistant | Summaries and questions answered on-device with Apple Intelligence, with a text-search fallback when Apple Intelligence is off |
| Batch | Run one tool on many PDFs: compress, OCR, page numbers, watermark, password, rotate, flatten, remove metadata, convert to JPG / Word / Excel / text |
| Convert | Excel (tables become rows and columns) and PowerPoint (one slide per page), with optional OCR for scanned pages; extract embedded images (JPEGs saved unchanged) |
| Repair | Rebuild every page of a damaged PDF through the content engine |
| More | Split by file size or merge chosen ranges, image watermarks, place a signature or stamp on every page / all but last / a range, visual overlay compare, translate on-device, scan with iPhone (Continuity Camera), right-to-left two-page reading, arrow-key nudging, light/dark appearance, notifications when long tasks finish |
| Updates | Checks GitHub Releases at launch and every six hours; shows a banner and a notification with *Download & Install* when a newer version is out |
| Other | Full undo/redo, document properties, print, share |

## Install

Download the latest `MK-PDF-x.y.z.dmg` from [Releases](https://github.com/mohamdbeam-star/MK-PDF/releases), open it and drag **MK PDF** into Applications. The build is ad-hoc signed, so the first time, right-click the app and choose **Open**.

## Release

```bash
echo 1.2.0 > VERSION      # then write RELEASE_NOTES.md and commit
scripts/release.sh        # builds the universal DMG, tags v1.2.0 and publishes the GitHub release
```

Every installed copy picks the new release up through its update check.

## Build

Requires macOS 15 or later and the Swift toolchain (Xcode or the Command Line Tools).

```bash
./build_app.sh          # builds "MK PDF.app" next to the script
open "MK PDF.app"
```

`UNIVERSAL=1 ./build_app.sh` builds for both Apple Silicon and Intel. Set `SIGN_IDENTITY` to a Developer ID certificate for a signed build.

## Tests

```bash
swift run MKPDFSelfTest                    # content engine checks
swift run MKPDFSelfTest some.pdf other.pdf # round-trip and word removal on your own files
swift build --product MKPDF && .build/debug/MKPDF --edit-smoke-test in.pdf out.pdf
.build/debug/MKPDF --feature-smoke-test in.pdf outdir   # Excel, PowerPoint, images, every batch tool, update logic
```

The self-test checks the parser, the page rewriter (each rewritten page must render identically and keep identical text), glyph-exact text removal that leaves the surrounding text in place, and image move, resize and delete. The edit smoke test runs the app's editing pipeline headlessly on a file.

## Known limits

- Text inside form XObjects, and text that is rotated or vertical, can't be edited in place yet. Use *Cover and retype selected text* for those.
- Scanned pages contain no text to edit. Run Scan & OCR first, then use cover-and-retype.
- Certificate-based digital signatures, PDF/A conversion and Excel/PowerPoint → PDF need a commercial PDF engine and aren't included.
- PowerPoint export places each page as a picture; text isn't editable on the slides.
- Type0 fonts are assumed to use 2-byte codes (Identity-H, by far the most common encoding).
