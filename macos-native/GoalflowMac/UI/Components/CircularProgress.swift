import SwiftUI

struct CircularProgress: View {
    var progress: Double // 0...1 (1 = full remaining)
    var lineWidth: CGFloat = 3
    var tint: Color = Color.accentColor
    var inactive: Bool = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.primary.opacity(0.08), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0, min(1, progress)))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                .rotationEffect(.degrees(-90))
                .opacity(inactive ? 0.0 : 1.0)
                .animation(.easeInOut(duration: 0.6), value: progress)
        }
    }
}
