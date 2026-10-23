import AppKit
import PDFKit
import MKPDFCore

private extension NSColor {
    var hex: String {
        guard let c = usingColorSpace(.sRGB) else { return "000000" }
        return String(format: "%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
    var css: String {
        guard let c = usingColorSpace(.sRGB) else { return "#000" }
        return String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}

private func twips(_ pt: CGFloat) -> Int { Int((pt * 20).rounded()) }
private func emu(_ pt: CGFloat) -> Int { Int((pt * 12700).rounded()) }

/// The page drawn without its text (for slide and web backgrounds that sit under editable text).
enum TextlessRender {
    static func jpeg(_ page: PDFPage, dpi: CGFloat, keepText: Bool = false) -> Data? {
        var source = page
        if !keepText, let stripped = ContentEditor.rewrite(page, edit: { $0.removeGlyphs { !$0.invisible } }) {
            for a in page.annotations { if let c = a.copy() as? PDFAnnotation { stripped.addAnnotation(c) } }
            source = stripped
        }
        guard let img = PageRenderer.image(of: source, dpi: dpi)?.rotated(by: page.normalizedRotation) else { return nil }
        return PageRenderer.jpegData(img, quality: 0.85)
    }
}

// MARK: - Word

enum DocxWriter {
    static func data(_ layouts: [PageLayout]) -> Data {
        var media: [(name: String, data: Data)] = []
        var drawingID = 0
        let first = layouts.first?.size ?? PageFactory.letter
        let bounds = layouts.reduce(CGRect.null) { $0.union($1.textBounds) }
        // Side margins follow the body text (long paragraphs), not headers or footers near the edge.
        var bodyRects: [CGRect] = []
        for l in layouts {
            for case .paragraph(let p) in l.items where p.text.count >= 40 { bodyRects.append(l.topLeft(p.rect)) }
        }
        let side = bodyRects.isEmpty ? bounds : bodyRects.reduce(CGRect.null) { $0.union($1) }
        let marginL = max(18, side.isNull ? 72 : side.minX), marginR = max(18, side.isNull ? 72 : first.width - side.maxX)
        // Small top/bottom margins; spacing before each item reproduces its vertical position.
        let topSpace: CGFloat = bounds.isNull ? 54 : bounds.minY
        let bottomSpace: CGFloat = bounds.isNull ? 36 : first.height - bounds.maxY
        let marginT = max(18, min(topSpace, 54)), marginB = max(18, min(bottomSpace, 36))
        let contentRight = first.width - marginR

        // Body font defaults to the most common family and size.
        var familyCount: [String: Int] = [:], sizeCount: [Int: Int] = [:]
        for l in layouts { for case .paragraph(let p) in l.items { for r in p.runs {
            familyCount[r.font.family, default: 0] += r.text.count
            sizeCount[Int(r.size * 2), default: 0] += r.text.count
        } } }
        let bodyFont = familyCount.max { $0.value < $1.value }?.key ?? "Calibri"
        let bodySize = sizeCount.max { $0.value < $1.value }?.key ?? 22

        func runXML(_ r: LayoutRun, rtl: Bool) -> String {
            var p = "<w:rFonts w:ascii=\"\(r.font.family.xmlEscaped)\" w:hAnsi=\"\(r.font.family.xmlEscaped)\" w:cs=\"\(r.font.family.xmlEscaped)\" w:eastAsia=\"\(r.font.family.xmlEscaped)\"/>"
            if r.font.bold { p += "<w:b/><w:bCs/>" }
            if r.font.italic { p += "<w:i/><w:iCs/>" }
            if r.color.hex != "000000" { p += "<w:color w:val=\"\(r.color.hex)\"/>" }
            let hp = max(2, Int((r.size * 2).rounded()))
            p += "<w:sz w:val=\"\(hp)\"/><w:szCs w:val=\"\(hp)\"/>"
            if rtl { p += "<w:rtl/>" }
            let content = r.text.components(separatedBy: "\t").map { "<w:t xml:space=\"preserve\">\($0.xmlEscaped)</w:t>" }.joined(separator: "<w:tab/>")
            return "<w:r><w:rPr>\(p)</w:rPr>\(content)</w:r>"
        }

        func imageGraphic(_ img: LayoutImage, cx: Int, cy: Int) -> String {
            drawingID += 1
            let name = "image\(media.count + 1).\(img.ext == "jpeg" ? "jpeg" : "png")"
            media.append((name, img.data))
            return """
            <wp:docPr id="\(drawingID)" name="Picture \(drawingID)"/><wp:cNvGraphicFramePr/>\
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="\(drawingID)" name="\(name)"/><pic:cNvPicPr/></pic:nvPicPr>\
            <pic:blipFill><a:blip r:embed="rIdImg\(media.count)"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="\(cx)" cy="\(cy)"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>
            """
        }

        var body = ""
        for (pi, layout) in layouts.enumerated() {
            var lastBottom = marginT
            var pendingAnchors = ""
            // Images sharing a band with text float at their exact position; others sit in the flow.
            let textRects = layout.items.compactMap { item -> CGRect? in
                if case .image = item { return nil }
                return layout.topLeft(item.rect)
            }
            for (index, item) in layout.items.enumerated() {
                let r = layout.topLeft(item.rect)
                let gap = max(0, r.minY - lastBottom)
                switch item {
                case .image(let img):
                    let cx = emu(r.width), cy = emu(r.height)
                    let floating = textRects.contains { $0.minY < r.maxY && $0.maxY > r.minY }
                    if floating {
                        // Anchor to the next text item, offset by the difference in height.
                        let anchorTop = layout.items[(index + 1)...].first { if case .image = $0 { return false }; return true }
                            .map { layout.topLeft($0.rect).minY } ?? r.minY
                        pendingAnchors += """
                        <w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="\(251658240 + index)" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">\
                        <wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>\(emu(r.minX))</wp:posOffset></wp:positionH>\
                        <wp:positionV relativeFrom="paragraph"><wp:posOffset>\(emu(r.minY - anchorTop))</wp:posOffset></wp:positionV>\
                        <wp:extent cx="\(cx)" cy="\(cy)"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>\(imageGraphic(img, cx: cx, cy: cy))</wp:anchor></w:drawing></w:r>
                        """
                    } else {
                        let centered = abs(r.midX - layout.size.width / 2) < 12
                        body += "<w:p><w:pPr><w:spacing w:before=\"\(twips(min(gap, 300)))\" w:after=\"0\"/>"
                            + (centered ? "<w:jc w:val=\"center\"/>" : "<w:ind w:left=\"\(twips(max(0, r.minX - marginL)))\"/>")
                            + "</w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"\(cx)\" cy=\"\(cy)\"/>"
                            + "<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\(imageGraphic(img, cx: cx, cy: cy))</wp:inline></w:drawing></w:r></w:p>"
                        lastBottom = r.maxY
                    }
                case .paragraph(let p):
                    var ppr = ""
                    if p.rightToLeft { ppr += "<w:bidi/>" }
                    let jc = (p.alignment == .center ? "center" : p.alignment == .right ? (p.rightToLeft ? "left" : "right") : p.alignment == .justified ? "both" : (p.rightToLeft ? "right" : "left"))
                    let firstLine = p.lines.count > 1 ? p.lines[0].rect.minX - p.lines[1].rect.minX : 0
                    let left = (p.lines.count > 1 ? p.lines[1].rect.minX : p.rect.minX)
                    let leftTL = layout.topLeft(CGRect(x: left, y: p.rect.minY, width: 1, height: 1)).minX
                    let pitchRule = p.lines.count > 1 && p.pitch > p.size * 0.95 && p.pitch < p.size * 2.2
                        ? "w:line=\"\(twips(p.pitch))\" w:lineRule=\"exact\"" : "w:line=\"240\" w:lineRule=\"auto\""
                    ppr += "<w:spacing w:before=\"\(twips(min(gap * 0.85, 600)))\" w:after=\"0\" \(pitchRule)/>"
                    if p.alignment != .center {
                        let rightIndent = p.lines.count > 1 ? max(0, contentRight - r.maxX - 2) : 0
                        ppr += "<w:ind w:left=\"\(twips(max(0, leftTL - marginL)))\" w:right=\"\(twips(rightIndent))\""
                            + (abs(firstLine) > 2 ? (firstLine > 0 ? " w:firstLine=\"\(twips(firstLine))\"" : " w:hanging=\"\(twips(-firstLine))\"") : "") + "/>"
                    }
                    if let stops = p.lines.first?.tabStops, !stops.isEmpty {
                        ppr += "<w:tabs>" + stops.map { x -> String in
                            let tl = layout.topLeft(CGRect(x: x, y: p.rect.minY, width: 1, height: 1)).minX
                            return "<w:tab w:val=\"left\" w:pos=\"\(twips(max(0, tl - marginL)))\"/>"
                        }.joined() + "</w:tabs>"
                    }
                    ppr += "<w:jc w:val=\"\(jc)\"/>"
                    body += "<w:p><w:pPr>\(ppr)</w:pPr>\(pendingAnchors)\(p.runs.map { runXML($0, rtl: p.rightToLeft) }.joined())</w:p>"
                    pendingAnchors = ""
                    lastBottom = r.maxY
                case .table(let t):
                    if gap > 4 { body += "<w:p><w:pPr><w:spacing w:before=\"\(twips(min(gap * 0.8, 300)))\" w:after=\"0\" w:line=\"20\" w:lineRule=\"exact\"/></w:pPr></w:p>" }
                    let starts = t.columns.map { layout.topLeft(CGRect(x: $0, y: t.rect.minY, width: 1, height: 1)).minX }
                    let rightTL = layout.topLeft(CGRect(x: t.right, y: t.rect.minY, width: 1, height: 1)).minX
                    var widths: [CGFloat] = []
                    for (i, s) in starts.enumerated() { widths.append(max(12, (i + 1 < starts.count ? starts[i + 1] : rightTL + 6) - s)) }
                    var xml = "<w:tbl><w:tblPr><w:tblW w:w=\"\(twips(widths.reduce(0, +)))\" w:type=\"dxa\"/><w:tblInd w:w=\"\(twips(max(0, (starts.first ?? marginL) - marginL - 4)))\" w:type=\"dxa\"/>"
                        + "<w:tblBorders>" + ["top", "left", "bottom", "right", "insideH", "insideV"].map { "<w:\($0) w:val=\"\(t.bordered ? "single" : "nil")\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/>" }.joined() + "</w:tblBorders>"
                        + "<w:tblLayout w:type=\"fixed\"/><w:tblCellMar><w:left w:w=\"60\" w:type=\"dxa\"/><w:right w:w=\"60\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr><w:tblGrid>"
                        + widths.map { "<w:gridCol w:w=\"\(twips($0))\"/>" }.joined() + "</w:tblGrid>"
                    for row in t.rows {
                        xml += "<w:tr>"
                        for (c, cell) in row.enumerated() {
                            let rtl = cell?.text.isRightToLeft ?? false
                            xml += "<w:tc><w:tcPr><w:tcW w:w=\"\(twips(widths[c]))\" w:type=\"dxa\"/></w:tcPr><w:p><w:pPr><w:spacing w:before=\"20\" w:after=\"20\"/>"
                                + (rtl ? "<w:bidi/>" : "") + "</w:pPr>" + (cell?.runs.map { runXML($0, rtl: rtl) }.joined() ?? "") + "</w:p></w:tc>"
                        }
                        xml += "</w:tr>"
                    }
                    body += xml + "</w:tbl>"
                    lastBottom = r.maxY
                }
            }
            if !pendingAnchors.isEmpty { body += "<w:p>\(pendingAnchors)</w:p>" }
            if pi < layouts.count - 1 { body += "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>" }
        }
        body += "<w:sectPr><w:pgSz w:w=\"\(twips(first.width))\" w:h=\"\(twips(first.height))\"\(first.width > first.height ? " w:orient=\"landscape\"" : "")/>"
            + "<w:pgMar w:top=\"\(twips(marginT))\" w:right=\"\(twips(marginR))\" w:bottom=\"\(twips(marginB))\" w:left=\"\(twips(marginL))\" w:header=\"0\" w:footer=\"0\" w:gutter=\"0\"/></w:sectPr>"

        var zip = ZipWriter()
        zip.add("[Content_Types].xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
        </Types>
        """)
        zip.add("_rels/.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>
        """)
        zip.add("word/_rels/document.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        \(media.enumerated().map { "<Relationship Id=\"rIdImg\($0.offset + 1)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/\($0.element.name)\"/>" }.joined())
        </Relationships>
        """)
        zip.add("word/styles.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="\(bodyFont.xmlEscaped)" w:hAnsi="\(bodyFont.xmlEscaped)" w:cs="\(bodyFont.xmlEscaped)" w:eastAsia="\(bodyFont.xmlEscaped)"/><w:sz w:val="\(bodySize)"/><w:szCs w:val="\(bodySize)"/></w:rPr></w:rPrDefault>
        <w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
        <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
        </w:styles>
        """)
        zip.add("word/document.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>\(body)</w:body></w:document>
        """)
        for m in media { zip.add("word/media/\(m.name)", m.data) }
        return zip.data()
    }
}

// MARK: - PowerPoint (editable)

enum PptxWriter {
    /// One slide per page: the page's artwork as the background and every line of text as an editable text box.
    static func data(_ layouts: [PageLayout], dpi: CGFloat = 150, progress: (Double) -> Void = { _ in }) -> Data {
        var zip = ZipWriter()
        let first = layouts.first?.size ?? PageFactory.letter
        let cx = emu(first.width), cy = emu(first.height)
        let count = layouts.count
        let ns = #"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#
        OfficeExport.addPresentationScaffold(&zip, count: count, cx: cx, cy: cy, ns: ns, imageExt: "jpeg")

        for (i, layout) in layouts.enumerated() {
            let lines: [(LayoutLine, NSTextAlignment, Bool)] = layout.items.flatMap { item -> [(LayoutLine, NSTextAlignment, Bool)] in
                switch item {
                case .paragraph(let p): return p.lines.flatMap { line in line.pieces.map { ($0, line.parts.isEmpty ? (p.alignment == .justified ? .left : p.alignment) : .left, $0.text.isRightToLeft) } }
                case .table(let t): return t.rows.flatMap { $0.compactMap { $0 } }.map { ($0, .left, $0.text.isRightToLeft) }
                case .image: return []
                }
            }
            let invisibleText = !lines.isEmpty && lines.allSatisfy { $0.0.runs.allSatisfy(\.invisible) }
            let background = TextlessRender.jpeg(layout.page, dpi: dpi, keepText: invisibleText) ?? Data()
            zip.add("ppt/media/image\(i + 1).jpeg", background)
            let scale = min(first.width / layout.size.width, first.height / layout.size.height)
            var shapes = """
            <p:pic><p:nvPicPr><p:cNvPr id="2" name="Page \(i + 1)"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
            <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="\(emu(layout.size.width * scale))" cy="\(emu(layout.size.height * scale))"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
            """
            for (n, entry) in lines.enumerated() {
                let (line, alignment, rtl) = entry
                // Box from the baseline: ascent above, descent below.
                let size = line.size
                let pageRect = CGRect(x: line.rect.minX - 1, y: line.baseline - size * 0.25, width: line.rect.width * 1.08 + 4, height: size * 1.2)
                let r = layout.topLeft(pageRect)
                let algn = alignment == .center ? "ctr" : alignment == .right ? "r" : "l"
                let runs = line.runs.map { run -> String in
                    let fill = run.invisible ? "<a:solidFill><a:srgbClr val=\"FFFFFF\"><a:alpha val=\"0\"/></a:srgbClr></a:solidFill>"
                        : "<a:solidFill><a:srgbClr val=\"\(run.color.hex)\"/></a:solidFill>"
                    return "<a:r><a:rPr lang=\"en-US\" sz=\"\(max(100, Int((run.size * scale * 100).rounded())))\"\(run.font.bold ? " b=\"1\"" : "")\(run.font.italic ? " i=\"1\"" : "") dirty=\"0\">\(fill)<a:latin typeface=\"\(run.font.family.xmlEscaped)\"/><a:cs typeface=\"\(run.font.family.xmlEscaped)\"/></a:rPr><a:t>\(run.text.xmlEscaped)</a:t></a:r>"
                }.joined()
                shapes += """
                <p:sp><p:nvSpPr><p:cNvPr id="\(n + 3)" name="Text \(n + 1)"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
                <p:spPr><a:xfrm><a:off x="\(emu(r.minX * scale))" y="\(emu(r.minY * scale))"/><a:ext cx="\(emu(r.width * scale))" cy="\(emu(r.height * scale))"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
                <p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:noAutofit/></a:bodyPr><a:lstStyle/>
                <a:p><a:pPr algn="\(algn)"\(rtl ? " rtl=\"1\"" : "")/>\(runs)</a:p></p:txBody></p:sp>
                """
            }
            zip.add("ppt/slides/slide\(i + 1).xml", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <p:sld \(ns)><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>\(shapes)</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>
            """)
            zip.add("ppt/slides/_rels/slide\(i + 1).xml.rels", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image\(i + 1).jpeg"/>
            </Relationships>
            """)
            progress(Double(i + 1) / Double(count))
        }
        return zip.data()
    }
}

// MARK: - HTML

enum HtmlWriter {
    /// A single self-contained page: each PDF page is its artwork plus selectable text placed exactly.
    static func data(_ layouts: [PageLayout], title: String, dpi: CGFloat = 130) -> Data {
        var pages = ""
        for layout in layouts {
            let lines: [LayoutLine] = layout.items.flatMap { item -> [LayoutLine] in
                switch item {
                case .paragraph(let p): return p.lines.flatMap(\.pieces)
                case .table(let t): return t.rows.flatMap { $0.compactMap { $0 } }
                case .image: return []
                }
            }
            let invisibleText = !lines.isEmpty && lines.allSatisfy { $0.runs.allSatisfy(\.invisible) }
            let bg = TextlessRender.jpeg(layout.page, dpi: dpi, keepText: invisibleText)?.base64EncodedString() ?? ""
            var spans = ""
            for line in lines {
                let size = line.size
                let r = layout.topLeft(CGRect(x: line.rect.minX, y: line.baseline, width: line.rect.width, height: 0))
                let rtl = line.text.isRightToLeft
                let runs = line.runs.map { run -> String in
                    var style = "font-family:'\(run.font.family.replacingOccurrences(of: "'", with: ""))',sans-serif;font-size:\(PDFValue.format(Double(run.size)))pt"
                    if run.font.bold { style += ";font-weight:bold" }
                    if run.font.italic { style += ";font-style:italic" }
                    style += run.invisible ? ";color:transparent" : ";color:\(run.color.css)"
                    return "<span style=\"\(style)\">\(run.text.xmlEscaped)</span>"
                }.joined()
                spans += "<div class=\"l\"\(rtl ? " dir=\"rtl\"" : "") data-w=\"\(PDFValue.format(Double(line.rect.width)))\" style=\"left:\(PDFValue.format(Double(r.minX)))pt;top:\(PDFValue.format(Double(r.minY - size * 0.82)))pt;line-height:\(PDFValue.format(Double(size)))pt\">\(runs)</div>"
            }
            pages += "<section class=\"page\" style=\"width:\(PDFValue.format(Double(layout.size.width)))pt;height:\(PDFValue.format(Double(layout.size.height)))pt;background-image:url(data:image/jpeg;base64,\(bg))\">\(spans)</section>\n"
        }
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\(title.xmlEscaped)</title>
        <style>body{margin:0;background:#e9e9ec;font-synthesis:weight style}.page{position:relative;margin:24px auto;background-size:100% 100%;box-shadow:0 2px 14px rgba(0,0,0,.18);overflow:hidden}
        .l{position:absolute;white-space:pre;transform-origin:0 0}.l[dir=rtl]{transform-origin:100% 0}@media print{body{background:none}.page{margin:0;box-shadow:none;page-break-after:always}}</style></head>
        <body>\(pages)<script>
        // Stretch each line to the width it had in the PDF, so substituted fonts still line up.
        for (const el of document.querySelectorAll('.l')) {
          const target = parseFloat(el.dataset.w) * 96 / 72, actual = el.getBoundingClientRect().width;
          if (actual > 0) el.style.transform = 'scaleX(' + Math.min(2, Math.max(0.5, target / actual)) + ')';
          if (el.dir === 'rtl') el.style.left = (parseFloat(el.style.left) * 96 / 72 + target - actual) + 'px';
        }
        </script></body></html>
        """
        return Data(html.utf8)
    }
}

// MARK: - Excel

enum XlsxWriter {
    /// One sheet per page; tables keep their columns, other text goes in column A in reading order.
    static func data(_ layouts: [PageLayout]) -> Data {
        var zip = ZipWriter()
        var sheets: [(String, String)] = []
        for (pi, layout) in layouts.enumerated() {
            var rows: [[(String, Bool)]] = []
            var colWidths: [CGFloat] = [60]
            for item in layout.items {
                switch item {
                case .paragraph(let p):
                    rows.append([(p.text, p.runs.contains { $0.font.bold })])
                case .table(let t):
                    if !rows.isEmpty { rows.append([]) }
                    for row in t.rows { rows.append(row.map { ($0?.text ?? "", $0?.runs.allSatisfy { $0.font.bold } ?? false) }) }
                    rows.append([])
                    for (i, s) in t.columns.enumerated() {
                        let w = (i + 1 < t.columns.count ? t.columns[i + 1] : t.right + 6) - s
                        if i < colWidths.count { colWidths[i] = max(colWidths[i], w) } else { colWidths.append(w) }
                    }
                case .image:
                    break
                }
            }
            var xml = ""
            for (r, row) in rows.enumerated() {
                xml += "<row r=\"\(r + 1)\">"
                for (c, cell) in row.enumerated() where !cell.0.isEmpty {
                    let ref = OfficeExport.column(c) + "\(r + 1)"
                    let s = cell.1 ? " s=\"1\"" : ""
                    if let n = OfficeExport.number(cell.0) { xml += "<c r=\"\(ref)\"\(s)><v>\(n)</v></c>" }
                    else { xml += "<c r=\"\(ref)\" t=\"inlineStr\"\(s)><is><t xml:space=\"preserve\">\(cell.0.xmlEscaped)</t></is></c>" }
                }
                xml += "</row>"
            }
            let cols = "<cols>" + colWidths.enumerated().map { "<col min=\"\($0.offset + 1)\" max=\"\($0.offset + 1)\" width=\"\(String(format: "%.1f", max(8, $0.element / 5.6)))\" customWidth=\"1\"/>" }.joined() + "</cols>"
            sheets.append(("Page \(pi + 1)", """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\(cols)<sheetData>\(xml)</sheetData></worksheet>
            """))
        }
        if sheets.isEmpty { sheets = [("Page 1", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>")] }
        zip.add("[Content_Types].xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        \(sheets.indices.map { "<Override PartName=\"/xl/worksheets/sheet\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>" }.joined())
        </Types>
        """)
        zip.add("_rels/.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>
        """)
        zip.add("xl/workbook.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>\(sheets.enumerated().map { "<sheet name=\"\($0.element.0)\" sheetId=\"\($0.offset + 1)\" r:id=\"rId\($0.offset + 1)\"/>" }.joined())</sheets></workbook>
        """)
        zip.add("xl/_rels/workbook.xml.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        \(sheets.indices.map { "<Relationship Id=\"rId\($0 + 1)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet\($0 + 1).xml\"/>" }.joined())
        <Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>
        """)
        zip.add("xl/styles.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
        <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
        <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
        <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
        <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
        </styleSheet>
        """)
        for (i, s) in sheets.enumerated() { zip.add("xl/worksheets/sheet\(i + 1).xml", s.1) }
        return zip.data()
    }
}

// MARK: - Text, Markdown and attributed text (RTF, Word 97, OpenDocument)

enum TextWriters {
    static func plainText(_ layouts: [PageLayout]) -> String {
        layouts.map { layout in
            layout.items.compactMap { item -> String? in
                switch item {
                case .paragraph(let p): return p.text
                case .table(let t): return t.rows.map { $0.map { $0?.text ?? "" }.joined(separator: "\t") }.joined(separator: "\n")
                case .image: return nil
                }
            }.joined(separator: "\n\n")
        }.joined(separator: "\n\n\u{0C}")
    }

    static func markdown(_ layouts: [PageLayout]) -> String {
        let sizes = layouts.flatMap { $0.items.compactMap { item -> CGFloat? in if case .paragraph(let p) = item { return p.size }; return nil } }.sorted()
        let body = sizes.isEmpty ? 12 : sizes[sizes.count / 2]
        func inline(_ runs: [LayoutRun]) -> String {
            runs.map { r in
                let t = r.text.replacingOccurrences(of: "*", with: "\\*").replacingOccurrences(of: "_", with: "\\_")
                let core = t.trimmingCharacters(in: .whitespaces)
                guard !core.isEmpty else { return t }
                let lead = t.prefix { $0 == " " }, trail = String(t.reversed().prefix { $0 == " " })
                var wrapped = core
                if r.font.bold { wrapped = "**\(wrapped)**" }
                if r.font.italic { wrapped = "*\(wrapped)*" }
                return lead + wrapped + trail
            }.joined()
        }
        var out: [String] = []
        var imageIndex = 0
        for layout in layouts {
            for item in layout.items {
                switch item {
                case .paragraph(let p):
                    let text = p.text.trimmingCharacters(in: .whitespaces)
                    if p.size >= body * 1.6 { out.append("# " + text) }
                    else if p.size >= body * 1.25 { out.append("## " + text) }
                    else if p.size >= body * 1.1 && p.runs.allSatisfy({ $0.font.bold }) { out.append("### " + text) }
                    else if let f = text.first, "•●▪◦–-".contains(f) { out.append("- " + inline(p.runs).drop { "•●▪◦–- ".contains($0) }) }
                    else { out.append(inline(p.runs)) }
                case .table(let t):
                    let rows = t.rows.map { "| " + $0.map { ($0?.text ?? "").replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |" }
                    guard let head = rows.first else { continue }
                    out.append(([head, "|" + String(repeating: " --- |", count: t.columns.count)] + rows.dropFirst()).joined(separator: "\n"))
                case .image(let img):
                    imageIndex += 1
                    out.append("![Image \(imageIndex)](data:image/\(img.ext);base64,\(img.data.base64EncodedString()))")
                }
            }
            out.append("---")
        }
        if out.last == "---" { out.removeLast() }
        return out.joined(separator: "\n\n") + "\n"
    }

    /// Styled text with real paragraph formatting and tables, for RTF / Word 97 / OpenDocument.
    static func attributed(_ layouts: [PageLayout]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        func append(_ runs: [LayoutRun], style: NSParagraphStyle) {
            for r in runs {
                out.append(NSAttributedString(string: r.text, attributes: [.font: r.font.nsFont(size: r.size), .foregroundColor: r.color, .paragraphStyle: style]))
            }
            out.append(NSAttributedString(string: "\n", attributes: [.paragraphStyle: style]))
        }
        for (pi, layout) in layouts.enumerated() {
            let left = layout.contentBounds.isNull ? 72 : layout.contentBounds.minX
            var lastBottom = layout.contentBounds.isNull ? 0 : layout.contentBounds.minY
            for item in layout.items {
                let r = layout.topLeft(item.rect)
                let gap = max(0, r.minY - lastBottom)
                lastBottom = r.maxY
                switch item {
                case .paragraph(let p):
                    let style = NSMutableParagraphStyle()
                    style.alignment = p.alignment
                    style.baseWritingDirection = p.rightToLeft ? .rightToLeft : .leftToRight
                    style.paragraphSpacingBefore = min(gap * 0.8, 40)
                    style.headIndent = max(0, r.minX - left)
                    style.firstLineHeadIndent = style.headIndent
                    if p.lines.count > 1 { style.minimumLineHeight = p.pitch; style.maximumLineHeight = p.pitch }
                    append(p.runs, style: style)
                case .table(let t):
                    let table = NSTextTable()
                    table.numberOfColumns = t.columns.count
                    table.collapsesBorders = true
                    for row in t.rows {
                        for (c, cell) in row.enumerated() {
                            let block = NSTextTableBlock(table: table, startingRow: 0, rowSpan: 1, startingColumn: c, columnSpan: 1)
                            block.setBorderColor(.lightGray)
                            block.setWidth(0.5, type: .absoluteValueType, for: .border)
                            block.setWidth(3, type: .absoluteValueType, for: .padding)
                            let style = NSMutableParagraphStyle()
                            style.textBlocks = [block]
                            append(cell?.runs ?? [LayoutRun(text: " ", font: LayoutFont(baseFont: "Helvetica"), size: 10, color: .black)], style: style)
                        }
                    }
                case .image:
                    continue
                }
            }
            if pi < layouts.count - 1 { out.append(NSAttributedString(string: "\u{0C}")) }
        }
        return out
    }
}

extension OfficeExport {
    /// Presentation parts shared by every deck: master, layout, theme and the slide list.
    static func addPresentationScaffold(_ zip: inout ZipWriter, count: Int, cx: Int, cy: Int, ns: String, imageExt: String) {
        zip.add("[Content_Types].xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>
        <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
        <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
        <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
        <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
        \((0..<count).map { "<Override PartName=\"/ppt/slides/slide\($0 + 1).xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>" }.joined())
        </Types>
        """)
        zip.add("_rels/.rels", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>
        """)
        zip.add("ppt/presentation.xml", """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:presentation \(ns)><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
        <p:sldIdLst>\((0..<count).map { "<p:sldId id=\"\(256 + $0)\" r:id=\"rId\($0 + 3)\"/>" }.joined())</p:sldIdLst>
        <p:sldSz cx="\(cx)" cy="\(cy)"/><p:notesSz cx="\(cy)" cy="\(cx)"/></p:presentation>
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
        <p:sldMaster \(ns)>\(emptyTree)<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
        <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>
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
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>
        """)
        zip.add("ppt/theme/theme1.xml", theme)
    }
}
