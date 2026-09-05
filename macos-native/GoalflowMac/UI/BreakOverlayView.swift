import SwiftUI

struct BreakOverlayView: View {
    var remainingSeconds: Int? // nil = open
    var elapsedSeconds: Int
    var isOpenEnded: Bool { remainingSeconds == nil }
    var durationMinutes: Int? // for title
    var onEndEarly: () -> Void

    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.05, blue: 0.05).ignoresSafeArea()
            VStack(spacing: 24) {
                Text(isOpenEnded ? "BREAK TIME" : "RECHARGE")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .tracking(6)
                    .foregroundStyle(Color(red: 0.45, green: 0.55, blue: 0.95))

                Text(formattedTime)
                    .font(.system(size: 120, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(
                        LinearGradient(colors: [Color.white, Color(white: 0.75)], startPoint: .top, endPoint: .bottom)
                    )
                    .shadow(color: .black.opacity(0.4), radius: 20, x: 0, y: 10)

                Text(isOpenEnded ? "Taking a moment..." : "Breathe. Relax. Reset.")
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.white.opacity(0.6))

                VStack(spacing: 12) {
                    Text("Press Esc to End Break Early")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .tracking(1.4)
                        .textCase(.uppercase)
                        .foregroundStyle(Color.white.opacity(0.35))

                    Button(action: onEndEarly) {
                        Text(isOpenEnded ? "Back to Flow" : "End Break Early")
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(Color.white.opacity(0.85))
                            .padding(.horizontal, 24).padding(.vertical, 12)
                            .background(Capsule().stroke(Color.white.opacity(0.25), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("End break early")
                    .accessibilityIdentifier("end-break-button")
                }
                .padding(.top, 8)
            }
            .padding(40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var formattedTime: String {
        if isOpenEnded {
            let m = elapsedSeconds / 60; let s = elapsedSeconds % 60
            return String(format: "%02d:%02d", m, s)
        } else if let r = remainingSeconds {
            let m = r / 60; let s = r % 60
            return String(format: "%02d:%02d", m, s)
        } else {
            return "--:--"
        }
    }
}
