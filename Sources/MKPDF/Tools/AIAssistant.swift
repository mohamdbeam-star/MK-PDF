import SwiftUI
import PDFKit
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Summaries and questions about the document, answered on-device.
enum AIAssistant {
    static var isModelAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) { return SystemLanguageModel.default.isAvailable }
        #endif
        return false
    }

    /// Splits text into chunks that fit comfortably in the on-device model's context.
    static func chunks(_ text: String, size: Int = 6000) -> [String] {
        var result: [String] = []
        var current = ""
        for paragraph in text.components(separatedBy: "\n") {
            if current.count + paragraph.count > size, !current.isEmpty {
                result.append(current)
                current = ""
            }
            current += paragraph + "\n"
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(current) }
        return result
    }

    static func summarize(_ text: String) async throws -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), SystemLanguageModel.default.isAvailable {
            let parts = chunks(text).prefix(12)
            var notes: [String] = []
            for part in parts {
                let session = LanguageModelSession(instructions: "You summarize documents accurately and concisely. Use only facts from the text.")
                notes.append(try await session.respond(to: "Summarize the key points of this part of a document in 3-5 bullet points:\n\n\(part)").content)
            }
            if notes.count == 1 { return notes[0] }
            let session = LanguageModelSession(instructions: "You merge partial summaries into one clear summary.")
            return try await session.respond(to: "Combine these notes into one summary with a one-sentence overview followed by up to 8 bullet points:\n\n\(notes.joined(separator: "\n\n"))").content
        }
        #endif
        return extractiveSummary(text)
    }

    static func answer(_ question: String, in text: String) async throws -> String {
        let passages = relevantPassages(question, in: text, limit: 4)
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), SystemLanguageModel.default.isAvailable {
            let session = LanguageModelSession(instructions: "Answer questions about a document using only the excerpts provided. If the answer isn't in them, say so.")
            return try await session.respond(to: "Excerpts:\n\(passages.joined(separator: "\n---\n"))\n\nQuestion: \(question)").content
        }
        #endif
        guard !passages.isEmpty else { return "I couldn't find anything about that in the document." }
        return "Most relevant passages:\n\n" + passages.map { "• " + $0.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: "\n\n")
    }

    /// Picks paragraphs sharing the most words with the question.
    static func relevantPassages(_ question: String, in text: String, limit: Int) -> [String] {
        let terms = Set(question.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count > 2 })
        let paragraphs = chunks(text, size: 900)
        let scored = paragraphs.map { p -> (String, Int) in
            let words = p.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            return (p, words.filter { terms.contains(String($0)) }.count)
        }
        return scored.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }

    /// Fallback summary: the sentences with the most frequent meaningful words.
    static func extractiveSummary(_ text: String, count: Int = 6) -> String {
        var sentences: [String] = []
        text.enumerateSubstrings(in: text.startIndex..., options: .bySentences) { s, _, _, _ in
            if let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), s.count > 30 { sentences.append(s) }
        }
        guard !sentences.isEmpty else { return "This document has no readable text. Run Scan & OCR first." }
        var freq: [String: Int] = [:]
        for w in text.lowercased().split(whereSeparator: { !$0.isLetter }) where w.count > 4 { freq[String(w), default: 0] += 1 }
        let ranked = sentences.enumerated().map { i, s -> (Int, String, Double) in
            let words = s.lowercased().split(whereSeparator: { !$0.isLetter })
            let score = Double(words.reduce(0) { $0 + (freq[String($1)] ?? 0) }) / Double(max(words.count, 1))
            return (i, s, score)
        }
        let top = ranked.sorted { $0.2 > $1.2 }.prefix(count).sorted { $0.0 < $1.0 }
        return top.map { "• " + $0.1 }.joined(separator: "\n")
    }
}

struct AIPanel: View {
    @ObservedObject var editor: EditorModel
    @State private var summary = ""
    @State private var question = ""
    @State private var history: [(q: String, a: String)] = []
    @State private var working = false

    var body: some View {
        HStack {
            Image(systemName: AIAssistant.isModelAvailable ? "cpu" : "text.magnifyingglass")
            Text(AIAssistant.isModelAvailable ? "Runs privately on this Mac with Apple Intelligence." : "Apple Intelligence is off, so answers use on-device text search.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Button { Task { await summarize() } } label: { Label("Summarize Document", systemImage: "text.redaction") }
            .buttonStyle(.borderedProminent).disabled(working)
        if !summary.isEmpty {
            Text(summary).textSelection(.enabled).font(.callout)
                .padding(10).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            Button("Copy Summary") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(summary, forType: .string)
            }
        }
        SectionTitle("Ask about this document")
        TextField("e.g. What is the total amount?", text: $question).textFieldStyle(.roundedBorder)
            .onSubmit { Task { await ask() } }
        if working { ProgressView().controlSize(.small) }
        ForEach(Array(history.enumerated().reversed()), id: \.offset) { _, item in
            VStack(alignment: .leading, spacing: 4) {
                Text(item.q).font(.callout.bold())
                Text(item.a).font(.callout).textSelection(.enabled)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var documentText: String { editor.pdf.pages.map { $0.string ?? "" }.joined(separator: "\n") }

    private func summarize() async {
        working = true
        defer { working = false }
        do { summary = try await AIAssistant.summarize(documentText) } catch { summary = "Couldn't summarize: \(error.localizedDescription)" }
    }

    private func ask() async {
        let q = question.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        working = true
        defer { working = false }
        let answer = (try? await AIAssistant.answer(q, in: documentText)) ?? "Couldn't answer that."
        history.append((q, answer))
        question = ""
    }
}
