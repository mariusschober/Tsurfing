import SwiftUI

struct FrogBadge: View {
    var compact: Bool = false
    var body: some View {
        Label(compact ? "Frog" : "Frog — do this first", systemImage: "leaf.fill")
            .font(.system(size: compact ? 10 : 11, weight: .bold, design: .rounded))
            .tracking(compact ? 0.4 : 0.6)
            .textCase(.uppercase)
            .padding(.horizontal, compact ? 8 : 10)
            .padding(.vertical, compact ? 4 : 5)
            .background(Color.green.opacity(0.14))
            .foregroundColor(.green)
            .overlay(RoundedRectangle(cornerRadius: 999).stroke(Color.green.opacity(0.22), lineWidth: 1))
            .clipShape(Capsule())
    }
}
