import SwiftUI
import PDFKit
import Vision

struct CommentPanel: View {
    @ObservedObject var editor: EditorModel
    @AppStorage("authorName") private var authorName = ""
    @AppStorage("dynamicStamps") private var dynamicStamps = true

    var body: some View {
        ToolGrid(editor: editor, tools: [.select, .hand, .highlight, .underline, .strikeout, .note, .text, .ink, .rectangle, .oval, .line, .arrow, .eraser])
        SectionTitle("Style")
        StyleControls(editor: editor)
        SectionTitle("Stamps")
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
            ForEach(StampFactory.stamps, id: \.self) { stamp in
                Button {
                    editor.armImage(StampFactory.image(stamp, author: editor.author, dynamic: dynamicStamps), kind: "Stamp")
                } label: {
                    Image(nsImage: StampFactory.image(stamp, author: nil, dynamic: false))
                        .resizable().aspectRatio(contentMode: .fit).frame(height: 26)
                        .frame(maxWidth: .infinity)
                        .padding(4)
                        .glassSurface(8, interactive: true)
                }
                .buttonStyle(.plain)
            }
        }
        Toggle("Add my name and the date to stamps", isOn: $dynamicStamps).font(.callout)
        SectionTitle("Comments")
        ActionRow(title: "Comment list", symbol: "list.bullet") {
            editor.sidebar = .comments
            editor.columnVisibility = .all
        }
        ActionRow(title: "Export comment summary…", symbol: "doc.plaintext") { editor.exportCommentSummary() }
        ActionRow(title: "Flatten comments into pages", symbol: "square.stack.3d.down.forward") { editor.flattenAnnotations(includeForms: false) }
        ActionRow(title: "Delete all comments", symbol: "trash") {
            if Panels.confirm("Delete all comments?", ok: "Delete", destructive: true) {
                editor.removeAll(where: \.isComment, name: "Delete All Comments")
            }
        }
        SectionTitle("Author")
        TextField(NSFullUserName(), text: $authorName).textFieldStyle(.roundedBorder)
    }
}

struct FillSignPanel: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject private var store = SignatureStore.shared

    var body: some View {
        Text("Click a form field to type into it, or place text and marks anywhere on the page.")
            .font(.callout).foregroundStyle(.secondary)
        ToolGrid(editor: editor, tools: [.select, .text, .check, .cross, .dot, .date])
        HStack {
            Text("Text size").font(.callout)
            Slider(value: $editor.fontSize, in: 6...36, step: 1)
            Text("\(Int(editor.fontSize))").monospacedDigit()
        }
        SectionTitle("Sign")
        if store.items.isEmpty {
            Text("No saved signatures yet.").font(.callout).foregroundStyle(.secondary)
        }
        ForEach(store.items) { item in
            Button { editor.armImage(item.image, kind: item.kind) } label: {
                HStack {
                    Image(nsImage: item.image).resizable().aspectRatio(contentMode: .fit).frame(height: 34)
                    Spacer()
                    Text(item.kind).font(.caption).foregroundStyle(.secondary)
                }
                .padding(8)
                .glassSurface(10, interactive: true)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu { Button("Delete", role: .destructive) { store.delete(item) } }
            .help("Click, then click on the page to place it")
        }
        HStack {
            Button { editor.sheet = .signature } label: { Label("Signature", systemImage: "plus") }
            Button { editor.sheet = .initials } label: { Label("Initials", systemImage: "plus") }
        }
        SectionTitle("Finish")
        ActionRow(title: "Clear form fields", symbol: "eraser") { editor.clearForm() }
        ActionRow(title: "Finalize (flatten fields and signatures)", symbol: "checkmark.seal", detail: "Makes everything part of the page") {
            editor.flattenAnnotations(includeForms: true)
        }
    }
}

struct EditPanel: View {
    @ObservedObject var editor: EditorModel
    private let families = ["Helvetica", "Helvetica Neue", "Arial", "Times New Roman", "Georgia", "Courier New", "Avenir Next",
                            "Gill Sans", "Verdana", "Futura", "Geeza Pro", "Al Nile", "Baghdad", "Damascus"]

    var body: some View {
        Button {
            editor.tool = editor.tool == .editContent ? .select : .editContent
        } label: {
            Label(editor.tool == .editContent ? "Done Editing" : "Edit Text & Images", systemImage: "character.cursor.ibeam")
                .frame(maxWidth: .infinity)
        }
        .glassButton(prominent: true)
        .controlSize(.large)
        if editor.tool == .editContent, editor.currentPageHasNoText {
            VStack(alignment: .leading, spacing: 8) {
                Label("No editable text on this page", systemImage: "text.viewfinder").font(.headline)
                Text("This page is a scanned image, or its text is drawn as shapes. Recognize the text to edit it in place: changes are painted over the original in matching size and colour.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button { editor.runOCR(pages: [editor.pageIndex], language: nil, accurate: true, skipTextPages: false) } label: {
                    Label("Make This Page Editable", systemImage: "wand.and.stars").frame(maxWidth: .infinity)
                }.glassButton(prominent: true)
                Button { editor.runOCR(pages: nil, language: nil, accurate: true, skipTextPages: true) } label: {
                    Text("All Scanned Pages").frame(maxWidth: .infinity)
                }.glassButton()
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.accentColor.opacity(0.08)))
        }
        if editor.tool == .editContent {
            Text("Click a paragraph to change its text. Drag a paragraph or image to move it; drag an image's corner to resize; press Delete to remove it. Double-click empty space to add text.")
                .font(.callout).foregroundStyle(.secondary)
            Button { editor.addingContentText = true } label: { Label("Add New Text…", systemImage: "plus") }
                .help("Click on the page where the text should go")
            if let style = editor.editStyle {
                SectionTitle("Text")
                Picker("Font", selection: Binding(
                    get: { style.font.familyName ?? "Helvetica" },
                    set: { family in
                        let traits = NSFontManager.shared.traits(of: style.font)
                        if let f = NSFontManager.shared.font(withFamily: family, traits: traits, weight: 5, size: style.font.pointSize) {
                            editor.editStyle?.font = f
                        }
                    }
                )) {
                    ForEach(Array(Set(families + [style.font.familyName ?? "Helvetica"])).sorted(), id: \.self) { Text($0).tag($0) }
                }
                Stepper("Size \(String(format: "%.1f", style.font.pointSize))") {
                    editor.editStyle?.font = style.font.withSize(style.font.pointSize + 0.5)
                } onDecrement: {
                    editor.editStyle?.font = style.font.withSize(max(3, style.font.pointSize - 0.5))
                }
                HStack {
                    Toggle(isOn: trait(.boldFontMask, style)) { Image(systemName: "bold") }.toggleStyle(.button)
                    Toggle(isOn: trait(.italicFontMask, style)) { Image(systemName: "italic") }.toggleStyle(.button)
                    Picker("", selection: Binding(get: { style.alignment }, set: { editor.editStyle?.alignment = $0 })) {
                        Image(systemName: "text.alignleft").tag(NSTextAlignment.left)
                        Image(systemName: "text.aligncenter").tag(NSTextAlignment.center)
                        Image(systemName: "text.alignright").tag(NSTextAlignment.right)
                    }
                    .pickerStyle(.segmented).labelsHidden()
                    ColorPicker("", selection: Binding(get: { Color(nsColor: style.color) }, set: { editor.editStyle?.color = NSColor($0) }))
                        .labelsHidden()
                }
                HStack {
                    Button("Cancel") { editor.pdfView?.cancelSession() }
                    Button("Apply") { editor.pdfView?.commitSession() }.keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.borderedProminent)
                }
            }
            if let (page, object) = editor.editObject {
                SectionTitle(object.kind == .form ? "Drawing" : "Image")
                Text(String(format: "%.0f × %.0f pt at (%.0f, %.0f)", object.bounds.width, object.bounds.height, object.bounds.minX, object.bounds.minY))
                    .font(.caption).foregroundStyle(.secondary)
                ActionRow(title: "Replace image…", symbol: "photo.badge.arrow.down") { editor.replaceObject(object, on: page) }
                ActionRow(title: "Save as PNG…", symbol: "square.and.arrow.down") { editor.saveObjectImage(object, on: page) }
                ActionRow(title: "Delete", symbol: "trash") { editor.deleteObject(object, on: page) }
            }
        }
        SectionTitle("Add")
        ToolGrid(editor: editor, tools: [.select, .text, .whiteout, .link, .crop, .ink])
        ActionRow(title: "Add image…", symbol: "photo") { editor.pickImageToPlace() }
        ActionRow(title: "Cover and retype selected text", symbol: "character.cursor.ibeam", detail: "For text inside scans or drawings") { editor.replaceSelectedText() }
        SectionTitle("Page design")
        ActionRow(title: "Watermark…", symbol: "drop") { editor.sheet = .watermark }
        ActionRow(title: "Header & footer…", symbol: "rectangle.topthird.inset.filled") { editor.sheet = .headerFooter }
        ActionRow(title: "Bates numbering…", symbol: "number") { editor.sheet = .batesNumbers }
        ActionRow(title: "Remove crop from all pages", symbol: "arrow.up.left.and.arrow.down.right") {
            editor.setCropBoxes(editor.pdf.pages.map { ($0, $0.bounds(for: .mediaBox)) })
        }
    }

    private func trait(_ mask: NSFontTraitMask, _ style: EditStyle) -> Binding<Bool> {
        Binding(get: { NSFontManager.shared.traits(of: style.font).contains(mask) },
                set: { on in
                    let f = on ? NSFontManager.shared.convert(style.font, toHaveTrait: mask) : NSFontManager.shared.convert(style.font, toNotHaveTrait: mask)
                    editor.editStyle?.font = f
                })
    }
}

struct OrganizePanel: View {
    @ObservedObject var editor: EditorModel

    var body: some View {
        ActionRow(title: editor.organizing ? "Back to document" : "Open page grid", symbol: "square.grid.3x3") { editor.organizing.toggle() }
        SectionTitle("Current page")
        HStack {
            Button { editor.rotateView(-90) } label: { Label("Left", systemImage: "rotate.left") }
            Button { editor.rotateView(90) } label: { Label("Right", systemImage: "rotate.right") }
            Button(role: .destructive) { editor.deletePages([editor.pageIndex]) } label: { Label("Delete", systemImage: "trash") }
        }
        ActionRow(title: "Insert blank page", symbol: "doc.badge.plus") { editor.insertBlankPage(after: editor.pageIndex) }
        ActionRow(title: "Insert from file…", symbol: "doc.on.doc") { editor.insertFromFile(after: editor.pageIndex) }
        ActionRow(title: "Replace page…", symbol: "arrow.triangle.2.circlepath") { editor.replacePage(editor.pageIndex) }
        SectionTitle("Document")
        ActionRow(title: "Extract pages…", symbol: "square.and.arrow.up.on.square") { editor.extractPages() }
        ActionRow(title: "Split document…", symbol: "scissors") { editor.sheet = .split }
        ActionRow(title: "Combine with other files…", symbol: "rectangle.stack.badge.plus") { editor.insertFromFile(after: editor.pageCount - 1) }
        ActionRow(title: "Reverse page order", symbol: "arrow.up.arrow.down") { editor.setPageOrder(editor.pdf.pages.reversed(), name: "Reverse Pages") }
        ActionRow(title: "Crop pages", symbol: "crop", detail: "Drag a box on the page") { editor.tool = .crop }
    }
}

struct FormsPanel: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument

    var body: some View {
        let _ = document.revision
        let fields = editor.pdf.pages.flatMap { $0.annotations.filter { $0.type == "Widget" } }
        Text("Choose a field type and drag on the page. With Select, drag fields to move them.")
            .font(.callout).foregroundStyle(.secondary)
        ToolGrid(editor: editor, tools: [.select, .textField, .checkbox, .dropdown])
        if let field = editor.selectedAnnotation, field.type == "Widget" {
            SectionTitle("Selected field")
            TextField("Name", text: Binding(get: { field.fieldName ?? "" }, set: { v in editor.editContinuously(field) { $0.fieldName = v } }))
                .textFieldStyle(.roundedBorder)
            if field.widgetFieldType == .text {
                Toggle("Multi-line", isOn: Binding(get: { field.isMultiline }, set: { v in editor.modify(field) { $0.isMultiline = v } }))
            }
            if field.widgetFieldType == .choice {
                TextField("Choices (comma separated)", text: Binding(
                    get: { (field.choices ?? []).joined(separator: ", ") },
                    set: { v in editor.editContinuously(field) { $0.choices = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } } }
                ))
                .textFieldStyle(.roundedBorder)
            }
            Button(role: .destructive) { editor.remove(field) } label: { Label("Delete Field", systemImage: "trash") }
        }
        SectionTitle("\(fields.count) fields")
        ForEach(fields, id: \.self) { field in
            HStack {
                Image(systemName: field.widgetFieldType == .button ? "checkmark.square" : field.widgetFieldType == .choice ? "filemenu.and.selection" : "character.cursor.ibeam")
                Text(field.fieldName ?? "Unnamed").lineLimit(1)
                Spacer()
                Text(field.widgetFieldType == .button ? (field.buttonWidgetState == .onState ? "On" : "Off") : (field.widgetStringValue ?? ""))
                    .foregroundStyle(.secondary).lineLimit(1)
            }
            .font(.callout)
            .contentShape(Rectangle())
            .onTapGesture { editor.reveal(field) }
        }
        SectionTitle("Form")
        ActionRow(title: "Clear form", symbol: "eraser") { editor.clearForm() }
        ActionRow(title: "Flatten form", symbol: "square.stack.3d.down.forward") { editor.flattenAnnotations(includeForms: true) }
        ActionRow(title: "Delete all fields", symbol: "trash") {
            if Panels.confirm("Delete all form fields?", ok: "Delete", destructive: true) {
                editor.removeAll(where: { $0.type == "Widget" }, name: "Delete Fields")
            }
        }
    }
}

struct RedactPanel: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var query = ""
    @State private var wholeWords = false
    @State private var dpi = 200.0
    @State private var ocrAfter = true

    var body: some View {
        let _ = document.revision
        let marks = editor.pdf.pages.flatMap { $0.annotations.filter(RedactionMark.isMark) }.count
        Text("Mark what to remove, then apply. Applying permanently deletes the marked text and images.")
            .font(.callout).foregroundStyle(.secondary)
        ToolGrid(editor: editor, tools: [.select, .redact])
        ActionRow(title: "Mark selected text", symbol: "text.badge.minus") { editor.markSelectionForRedaction() }
        SectionTitle("Find and redact")
        TextField("Text, email, number…", text: $query).textFieldStyle(.roundedBorder)
        Toggle("Whole words only", isOn: $wholeWords).font(.callout)
        Button("Mark All Matches") {
            let n = editor.markMatchesForRedaction(query, wholeWords: wholeWords)
            if n == 0 { Panels.alert("No matches for “\(query)”") }
        }
        .disabled(query.isEmpty)
        SectionTitle("\(marks) marked areas")
        Picker("Quality", selection: $dpi) {
            Text("Standard (150 dpi)").tag(150.0)
            Text("High (200 dpi)").tag(200.0)
            Text("Best (300 dpi)").tag(300.0)
        }
        Toggle("Keep the rest of the page searchable (OCR)", isOn: $ocrAfter).font(.callout)
        Button("Apply Redactions") { editor.applyRedactions(dpi: dpi, ocr: ocrAfter) }
            .buttonStyle(.borderedProminent).tint(.red).disabled(marks == 0)
        Button("Remove All Marks") { editor.removeAll(where: RedactionMark.isMark, name: "Remove Marks") }.disabled(marks == 0)
        SectionTitle("Hidden information")
        ActionRow(title: "Remove metadata", symbol: "info.circle", detail: "Title, author, keywords, dates") { editor.removeMetadata() }
    }
}

struct ProtectPanel: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var openPassword = ""
    @State private var confirm = ""
    @State private var restrict = false
    @State private var ownerPassword = ""
    @State private var allowPrint = true
    @State private var allowCopy = false
    @State private var allowEdit = false
    @State private var allowComment = true
    @State private var allowForms = true

    var body: some View {
        HStack {
            Image(systemName: document.security == nil ? "lock.open" : "lock.fill")
                .foregroundStyle(document.security == nil ? Color.secondary : Color.green)
            Text(statusText).font(.callout)
        }
        SectionTitle("Require a password to open")
        SecureField("Password", text: $openPassword).textFieldStyle(.roundedBorder)
        SecureField("Confirm password", text: $confirm).textFieldStyle(.roundedBorder)
        SectionTitle("Restrict editing")
        Toggle("Restrict printing, copying and editing", isOn: $restrict)
        if restrict {
            SecureField("Permissions password", text: $ownerPassword).textFieldStyle(.roundedBorder)
            Toggle("Allow printing", isOn: $allowPrint)
            Toggle("Allow copying text and images", isOn: $allowCopy)
            Toggle("Allow page changes", isOn: $allowEdit)
            Toggle("Allow comments", isOn: $allowComment)
            Toggle("Allow filling forms", isOn: $allowForms)
        }
        Button("Apply Protection", action: apply).buttonStyle(.borderedProminent)
            .disabled(openPassword.isEmpty && !restrict)
        if document.security != nil {
            Button("Remove Protection", role: .destructive) { editor.setSecurity(nil) }
        }
        Text("Protection is applied when you save. Uses AES encryption.").font(.caption).foregroundStyle(.secondary)
    }

    private var statusText: String {
        guard let s = document.security else { return "Not protected" }
        let open = (s.userPassword?.isEmpty == false) ? "Password to open" : "No open password"
        let limited = s.permissions != SecuritySettings.allPermissions ? " · editing restricted" : ""
        return open + limited
    }

    private func apply() {
        guard openPassword == confirm else {
            Panels.alert("Passwords don't match")
            return
        }
        if restrict && ownerPassword.isEmpty {
            Panels.alert("Enter a permissions password", "It's needed to change the restrictions later.")
            return
        }
        var permissions: SecuritySettings.Permissions = restrict ? [.contentAccessibility] : SecuritySettings.allPermissions
        if restrict {
            if allowPrint { permissions.formUnion([.lowQualityPrinting, .highQualityPrinting]) }
            if allowCopy { permissions.insert(.contentCopying) }
            if allowEdit { permissions.formUnion([.documentChanges, .documentAssembly]) }
            if allowComment { permissions.insert(.commenting) }
            if allowForms { permissions.insert(.formFieldEntry) }
        }
        let owner = restrict ? ownerPassword : (openPassword.isEmpty ? UUID().uuidString : openPassword)
        editor.setSecurity(SecuritySettings(userPassword: openPassword.isEmpty ? nil : openPassword, ownerPassword: owner, permissions: permissions))
        openPassword = ""
        confirm = ""
    }
}

struct OCRPanel: View {
    @ObservedObject var editor: EditorModel
    @State private var allPages = true
    @State private var language = "auto"
    @State private var accurate = true
    @State private var skipText = true

    var body: some View {
        Text("Recognize text in scanned pages so you can search, select and copy it.")
            .font(.callout).foregroundStyle(.secondary)
        Picker("Pages", selection: $allPages) {
            Text("All pages").tag(true)
            Text("Current page").tag(false)
        }
        Picker("Language", selection: $language) {
            Text("Automatic").tag("auto")
            ForEach(OCR.supportedLanguages(), id: \.self) { code in
                Text(Locale.current.localizedString(forIdentifier: code) ?? code).tag(code)
            }
        }
        Picker("Mode", selection: $accurate) {
            Text("Accurate").tag(true)
            Text("Fast").tag(false)
        }
        .pickerStyle(.segmented)
        Toggle("Skip pages that already have text", isOn: $skipText).font(.callout)
        Button("Recognize Text") {
            editor.runOCR(pages: allPages ? nil : [editor.pageIndex], language: language == "auto" ? nil : language, accurate: accurate, skipTextPages: skipText)
        }
        .buttonStyle(.borderedProminent)
        SectionTitle("Scan")
        ActionRow(title: "Create PDF from images…", symbol: "photo.on.rectangle", detail: "Photos or scans, one page each") {
            Creator.fromImages()
        }
    }
}

struct CompressPanel: View {
    @ObservedObject var editor: EditorModel
    @ObservedObject var document: PDFFileDocument
    @State private var preset = Compressor.Preset.balanced
    @State private var current: Int?
    @State private var estimate: Int?

    var body: some View {
        Text("Reduce the file size for sharing and email.").font(.callout).foregroundStyle(.secondary)
        Picker("Quality", selection: $preset) {
            ForEach(Compressor.Preset.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.radioGroup)
        Text(preset.detail).font(.caption).foregroundStyle(.secondary)
        HStack {
            Button("Check Size") { measure() }
            Button("Compress") { editor.compress(preset) }.buttonStyle(.borderedProminent)
        }
        if let current {
            Text("Current: \(format(current))").font(.callout)
            if let estimate {
                Text("After: \(format(estimate)) (\(Int((1 - Double(estimate) / Double(max(current, 1))) * 100))% smaller)")
                    .font(.callout.bold())
            }
        }
    }

    private func format(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }

    private func measure() {
        let pdf = editor.pdf
        current = (try? PDFExporter.data(for: pdf))?.count
        estimate = nil
        editor.run("Estimating size…") { progress in
            try Compressor.compressedData(pdf, preset: preset, progress: progress).count
        } then: { estimate = $0 }
    }
}

struct ExportPanel: View {
    @ObservedObject var editor: EditorModel
    @State private var dpi = 150.0
    @State private var ocr = true
    @State private var quality = 0.9

    var body: some View {
        Text("Layout, fonts, colours, tables and images are rebuilt from the page, so files open looking like the PDF.")
            .font(.caption).foregroundStyle(.secondary)
        Toggle("Recognize text in scanned pages (OCR)", isOn: $ocr).font(.callout)
        SectionTitle("Office")
        ActionRow(title: "Word (.docx)", symbol: "doc.richtext", detail: "Editable paragraphs, tables and images") { editor.exportOffice(.word, ocr: ocr) }
        ActionRow(title: "Excel (.xlsx)", symbol: "tablecells", detail: "Tables keep their columns; one sheet per page") { editor.exportOffice(.excel, ocr: ocr) }
        ActionRow(title: "PowerPoint (.pptx)", symbol: "rectangle.on.rectangle", detail: "Editable text over each page's artwork") { editor.exportOffice(.powerpoint, ocr: false) }
        ActionRow(title: "Word 97 (.doc)", symbol: "doc") { editor.exportOffice(.word97, ocr: ocr) }
        ActionRow(title: "OpenDocument (.odt)", symbol: "doc.text") { editor.exportOffice(.odt, ocr: ocr) }
        SectionTitle("Text & web")
        ActionRow(title: "Web page (.html)", symbol: "globe", detail: "One file, exact layout, selectable text") { editor.exportOffice(.html, ocr: false) }
        ActionRow(title: "Rich Text (.rtf)", symbol: "doc.plaintext") { editor.exportOffice(.rtf, ocr: ocr) }
        ActionRow(title: "Markdown (.md)", symbol: "number", detail: "Headings, bold, lists and tables") { editor.exportOffice(.markdown, ocr: ocr) }
        ActionRow(title: "Plain text (.txt)", symbol: "text.alignleft") { editor.exportOffice(.text, ocr: ocr) }
        ActionRow(title: "CSV (.csv)", symbol: "tablecells.badge.ellipsis") { editor.exportOffice(.csv, ocr: ocr) }
        SectionTitle("Images")
        Picker("Resolution", selection: $dpi) {
            Text("72 dpi").tag(72.0)
            Text("150 dpi").tag(150.0)
            Text("300 dpi").tag(300.0)
            Text("600 dpi").tag(600.0)
        }
        HStack {
            Text("Quality").font(.callout)
            Slider(value: $quality, in: 0.3...1)
            Text("\(Int(quality * 100))%").monospacedDigit().font(.callout)
        }
        .onChange(of: quality) { _, q in editor.imageQuality = q }
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
            ForEach([ExportFormat.png, .jpeg, .heic, .webp, .tiff, .bmp, .gif], id: \.fileExtension) { f in
                Button(f.fileExtension.uppercased()) { editor.export(f, dpi: dpi) }.frame(maxWidth: .infinity)
            }
        }
        ActionRow(title: "Extract embedded images", symbol: "photo.on.rectangle.angled", detail: "Original JPEGs are saved unchanged") { editor.extractAllImages() }
        SectionTitle("PDF")
        ActionRow(title: "Selected pages as PDF…", symbol: "doc.on.doc") { editor.extractPages() }
        ActionRow(title: "Flattened PDF (print-ready)", symbol: "printer", detail: "Annotations and forms merged into pages") { editor.export(.flattened) }
        ActionRow(title: "Grayscale PDF", symbol: "circle.lefthalf.filled") { editor.export(.grayscale) }
        ActionRow(title: "PDF/X-3 for print", symbol: "printer.filled.and.paper") { editor.export(.pdfx) }
            .onAppear { quality = Double(editor.imageQuality) }
    }
}

struct MorePanel: View {
    @ObservedObject var editor: EditorModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ActionRow(title: "Document properties…", symbol: "info.circle") { editor.sheet = .properties }
        ActionRow(title: editor.speaking ? "Stop reading" : "Read aloud", symbol: editor.speaking ? "stop.circle" : "speaker.wave.2", detail: "Reads the selection or from this page") {
            editor.toggleReadAloud()
        }
        ActionRow(title: "Compare with another PDF…", symbol: "doc.on.doc") {
            guard let other = Panels.open([.pdf], title: "Choose the PDF to compare with").first else { return }
            guard let mine = editor.fileURL else {
                Panels.alert("Save this document first", "Compare works with saved files.")
                return
            }
            openWindow(id: "compare", value: CompareRequest(original: mine, revised: other))
        }
        ActionRow(title: "Combine files…", symbol: "rectangle.stack.badge.plus") { openWindow(id: "combine") }
        ActionRow(title: "Batch process files…", symbol: "square.stack.3d.forward.dottedline", detail: "One tool on many PDFs") { openWindow(id: "batch") }
        ActionRow(title: "Repair PDF", symbol: "bandage", detail: "Rebuild damaged pages") { editor.repairDocument() }
        ActionRow(title: "Remove all images", symbol: "photo.badge.minus") { editor.removeAllImages() }
        ActionRow(title: "Print…", symbol: "printer") { editor.printDocument() }
        Toggle("Night reading mode", isOn: $editor.nightMode)
        ActionRow(title: "Read mode (full screen)", symbol: "arrow.up.left.and.arrow.down.right") { editor.enterReadMode() }
    }
}
