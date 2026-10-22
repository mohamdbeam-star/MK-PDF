// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "MKPDF",
    platforms: [.macOS(.v15)],
    targets: [
        // PDF content engine: parses and rewrites page content so existing text and images can be edited.
        .target(name: "MKPDFCore", path: "Sources/MKPDFCore"),
        .executableTarget(name: "MKPDF", dependencies: ["MKPDFCore"], path: "Sources/MKPDF"),
        // Run with `swift run MKPDFSelfTest`; XCTest isn't available with Command Line Tools alone.
        .executableTarget(name: "MKPDFSelfTest", dependencies: ["MKPDFCore"], path: "Tests/MKPDFSelfTest"),
    ],
    swiftLanguageModes: [.v5]
)
