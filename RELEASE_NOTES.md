## What's new in MK PDF 1.3.1

**Editing PDFs saved from web browsers (Mac)**
- PDFs made with Chrome, Edge or other Chromium browsers ("Save as PDF", many web reports and AI-generated documents) use a font type that macOS turned into plain shapes whenever the file was saved after an edit. After the first save, the rest of the text could no longer be selected or edited, and exports came out broken. MK PDF now keeps every page's original text exactly as it was: you can edit, save and edit again as often as you like.
- The same protection applies to everything that adds to a page: OCR, watermarks, headers and footers, stamps and inserted pages.
- New text typed into these documents uses the document's own font (for example Roboto, bold or regular) instead of Helvetica.

**Word export for web-style documents**
- Tables drawn with row lines only (no vertical lines) come out as one proper table with all their columns, instead of several pieces.
- Banners, notice boxes and cards are rebuilt as shaded boxes with their colours, borders and accent stripes; cards side by side stay side by side.
- Charts and diagrams are placed as pictures, so they look exactly like the original.
- Bold and regular text inside a line keep their own sizes (for example "3,300 AED" large and "upfront" small).
- Only content that repeats on several pages goes into Word's header and footer, so a section heading near the top of a page stays in the body.
- Fonts that may not be installed (web fonts such as Roboto or Inter) are declared with a common fallback, so Word substitutes Arial rather than Times.

**Earlier exports from edited files**
- If a file was already saved by MK PDF 1.3.0 or earlier after editing, its text may already be shapes. Open the original (unedited) file and redo the edits for fully editable text.
