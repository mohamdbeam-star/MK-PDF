import AppKit
import PDFKit
import MKPDFCore
import UniformTypeIdentifiers

/// One row of positioned text cells, read from glyph positions.
struct TextRow {
    var baseline: CGFloat
    var cells: [(rect: CGRect, text: String)]
}

extension ContentEditor {
    /// Rows of text cells on a page. A cell ends at a gap wider than about a character or at a run of
    /// two or more spaces, so table columns come out as separate cells.
    static func rows(on page: PDFPage) -> [TextRow] {
        guard let ref = page.pageRef else { return [] }
        let glyphs = PageContent(page: ref).glyphs.filter { $0.upright && $0.size > 0.5 }
            .sorted { abs($0.origin.y - $1.origin.y) > 1 ? $0.origin.y > $1.origin.y : $0.rect.minX < $1.rect.minX }
        func isSpace(_ g: Glyph) -> Bool { g.bytes == Data([32]) || g.bytes == Data([0, 3]) }

        var rows: [TextRow] = []
        var current: [Glyph] = []
        var cellRects: [CGRect] = []
        var spaces = 0
        func flushCell() {
            let visible = current.filter { !isSpace($0) }
            if !visible.isEmpty { cellRects.append(visible.reduce(CGRect.null) { $0.union($1.rect) }) }
            current = []
        }
        func flushRow(_ baseline: CGFloat) {
            flushCell()
            guard !cellRects.isEmpty else { return }
            let cells = cellRects.compactMap { r -> (CGRect, String)? in
                let probe = r.insetBy(dx: -0.5, dy: r.height * 0.25)
                guard let s = page.selection(for: probe)?.string?.replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
                return (r, s)
            }
            if !cells.isEmpty { rows.append(TextRow(baseline: baseline, cells: cells)) }
            cellRects = []
        }
        var rowBaseline: CGFloat?
        var lastVisible: Glyph?
        for g in glyphs {
            if let b = rowBaseline, abs(g.origin.y - b) > max(1, g.size * 0.3) {
                flushRow(b)
                lastVisible = nil
                spaces = 0
                rowBaseline = nil
            }
            if rowBaseline == nil { rowBaseline = g.origin.y }
            if isSpace(g) {
                spaces += 1
                if spaces == 2 { flushCell() }
                current.append(g)
                continue
            }
            if let last = lastVisible, g.rect.minX - last.rect.maxX > max(g.size, last.size) * 0.9, spaces < 2 { flushCell() }
            spaces = 0
            current.append(g)
            lastVisible = g
        }
        if let b = rowBaseline { flushRow(b) }
        return rows
    }

    /// Rows as a grid: cells are assigned to columns by clustering their left edges across the page.
    static func table(on page: PDFPage) -> [[String]] {
        let rows = rows(on: page)
        var columns: [CGFloat] = []
        for x in rows.flatMap({ $0.cells.map(\.rect.minX) }).sorted() {
            if let last = columns.last, x - last < 12 { continue }
            columns.append(x)
        }
        return rows.map { row in
            var out = [String](repeating: "", count: max(columns.count, 1))
            for cell in row.cells {
                let col = columns.lastIndex { $0 <= cell.rect.minX + 6 } ?? 0
                out[col] = out[col].isEmpty ? cell.text : out[col] + " " + cell.text
            }
            while out.count > 1, out.last == "" { out.removeLast() }
            return out
        }
    }
}

enum OfficeExport {
    // MARK: - Excel

    static func xlsx(_ pdf: PDFDocument) -> Data {
        var zip = ZipWriter()
        let sheets = pdf.pages.enumerated().map { ($0.offset + 1, ContentEditor.table(on: $0.element)) }.filter { !$0.1.isEmpty }
        let list = sheets.isEmpty ? [(1, [[String]]())] : sheets
        zip.add("[Content_Types].xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        \(list.indices.map { "<Override PartName=\"/xl/worksheets/sheet\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>" }.joined())
        </Types>
        """)
        zip.add("_rels/.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>
        """)
        zip.add("xl/workbook.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>\(list.enumerated().map { "<sheet name=\"Page \($0.element.0)\" sheetId=\"\($0.offset + 1)\" r:id=\"rId\($0.offset + 1)\"/>" }.joined())</sheets>
        </workbook>
        """)
        zip.add("xl/_rels/workbook.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        \(list.indices.map { "<Relationship Id=\"rId\($0 + 1)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet\($0 + 1).xml\"/>" }.joined())
        </Relationships>
        """)
        for (i, sheet) in list.enumerated() {
            var rows = ""
            for (r, row) in sheet.1.enumerated() {
                rows += "<row r=\"\(r + 1)\">"
                for (c, value) in row.enumerated() where !value.isEmpty {
                    let ref = column(c) + "\(r + 1)"
                    if let n = number(value) {
                        rows += "<c r=\"\(ref)\"><v>\(n)</v></c>"
                    } else {
                        rows += "<c r=\"\(ref)\" t=\"inlineStr\"><is><t xml:space=\"preserve\">\(value.xmlEscaped)</t></is></c>"
                    }
                }
                rows += "</row>"
            }
            zip.add("xl/worksheets/sheet\(i + 1).xml", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>\(rows)</sheetData></worksheet>
            """)
        }
        return zip.data()
    }

    static func column(_ i: Int) -> String {
        var n = i + 1, s = ""
        while n > 0 {
            let r = (n - 1) % 26
            s = String(UnicodeScalar(65 + r)!) + s
            n = (n - 1) / 26
        }
        return s
    }

    /// Plain numbers ("1,200", "-3.5") become numeric cells; anything else stays text.
    static func number(_ s: String) -> String? {
        let cleaned = s.replacingOccurrences(of: ",", with: "")
        guard cleaned.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) != nil, cleaned.count < 16 else { return nil }
        return cleaned
    }

    // MARK: - PowerPoint

    /// One slide per page, each showing the page as a picture.
    static func pptx(_ pdf: PDFDocument, dpi: CGFloat = 150, progress: (Double) -> Void = { _ in }) -> Data {
        var zip = ZipWriter()
        let first = pdf.page(at: 0)?.displaySize ?? PageFactory.letter
        let emu = { (pt: CGFloat) in Int(pt * 12700) }
        let cx = emu(first.width), cy = emu(first.height)
        let count = pdf.pageCount

        zip.add("[Content_Types].xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/>
        <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
        <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
        <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
        <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
        \((0..<count).map { "<Override PartName=\"/ppt/slides/slide\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>" }.joined())
        </Types>
        """)
        zip.add("_rels/.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
        </Relationships>
        """)
        let ns = #"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#
        zip.add("ppt/presentation.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:presentation \(ns)>
        <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
        <p:sldIdLst>\((0..<count).map { "<p:sldId id=\"\(256 + $0)\" r:id=\"rId\($0 + 3)\"/>" }.joined())</p:sldIdLst>
        <p:sldSz cx="\(cx)" cy="\(cy)"/><p:notesSz cx="\(cy)" cy="\(cx)"/>
        </p:presentation>
        """)
        zip.add("ppt/_rels/presentation.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
        \((0..<count).map { "<Relationship Id=\"rId\($0 + 3)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide\($0 + 1).xml\"/>" }.joined())
        </Relationships>
        """)
        let emptyTree = #"<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>"#
        zip.add("ppt/slideMasters/slideMaster1.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:sldMaster \(ns)>\(emptyTree)
        <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
        <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
        </p:sldMaster>
        """)
        zip.add("ppt/slideMasters/_rels/slideMaster1.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
        </Relationships>
        """)
        zip.add("ppt/slideLayouts/slideLayout1.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:sldLayout \(ns) type="blank">\(emptyTree)<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>
        """)
        zip.add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
        </Relationships>
        """)
        zip.add("ppt/theme/theme1.xml", theme)

        for i in 0..<count {
            guard let page = pdf.page(at: i), let image = PageRenderer.image(of: page, dpi: dpi)?.rotated(by: page.normalizedRotation),
                  let png = PageRenderer.encode(image, type: .png) else { continue }
            zip.add("ppt/media/image\(i + 1).png", png)
            // Fit the page inside the slide, centred.
            let size = page.displaySize
            let scale = min(first.width / size.width, first.height / size.height)
            let w = emu(size.width * scale), h = emu(size.height * scale)
            zip.add("ppt/slides/slide\(i + 1).xml", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <p:sld \(ns)><p:cSld><p:spTree>
            <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
            <p:pic><p:nvPicPr><p:cNvPr id="2" name="Page \(i + 1)"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
            <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
            <p:spPr><a:xfrm><a:off x="\((cx - w) / 2)" y="\((cy - h) / 2)"/><a:ext cx="\(w)" cy="\(h)"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
            </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>
            """)
            zip.add("ppt/slides/_rels/slide\(i + 1).xml.rels", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image\(i + 1).png"/>
            </Relationships>
            """)
            progress(Double(i + 1) / Double(count))
        }
        return zip.data()
    }

    private static let theme = """
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MK PDF"><a:themeElements>
    <a:clrScheme name="MK PDF"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    <a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    <a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="MK PDF"><a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
    <a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="MK PDF"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
    <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
    <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
    <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
    </a:themeElements></a:theme>
    """
}
