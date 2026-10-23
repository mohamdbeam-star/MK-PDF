import SwiftUI

// Liquid Glass on macOS 26 and later, with matching materials on macOS 15.

extension View {
    /// A glass surface in a rounded rectangle; `tint` marks a selected state.
    @ViewBuilder
    func glassSurface(_ radius: CGFloat = 12, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffect(Glass.regular.tint(tint).interactive(interactive), in: .rect(cornerRadius: radius))
        } else {
            self.background(tint.map { AnyShapeStyle($0.opacity(0.35)) } ?? AnyShapeStyle(.regularMaterial),
                            in: RoundedRectangle(cornerRadius: radius))
        }
    }

    /// Glass capsule, for floating bars and banners.
    @ViewBuilder
    func glassCapsule(tint: Color? = nil) -> some View {
        if #available(macOS 26.0, *) {
            self.glassEffect(Glass.regular.tint(tint), in: .capsule)
        } else {
            self.background(.regularMaterial, in: Capsule())
        }
    }

    @ViewBuilder
    func glassButton(prominent: Bool = false) -> some View {
        if #available(macOS 26.0, *) {
            if prominent { self.buttonStyle(.glassProminent) } else { self.buttonStyle(.glass) }
        } else {
            if prominent { self.buttonStyle(.borderedProminent) } else { self.buttonStyle(.bordered) }
        }
    }

    /// Groups nearby glass shapes so they blend and morph together.
    @ViewBuilder
    func glassGroup(spacing: CGFloat = 8) -> some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}

/// The brand backdrop that glass surfaces refract on the home and tool windows.
struct BrandBackdrop: View {
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            Circle().fill(Color(red: 1, green: 0.35, blue: 0.35).opacity(0.22)).frame(width: 420).blur(radius: 90).offset(x: -260, y: -180)
            Circle().fill(Color(red: 0.55, green: 0.2, blue: 0.9).opacity(0.2)).frame(width: 460).blur(radius: 100).offset(x: 280, y: 200)
            Circle().fill(Color(red: 0.95, green: 0.2, blue: 0.5).opacity(0.14)).frame(width: 300).blur(radius: 80).offset(x: 120, y: -220)
        }
        .ignoresSafeArea()
    }
}
