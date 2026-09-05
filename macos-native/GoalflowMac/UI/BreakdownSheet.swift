import SwiftUI

struct BreakdownSheet: View {
    @ObservedObject var vm: ExecutionViewModel
    @Environment(\.dismiss) var dismiss
    @State private var manualTitle = ""
    @State private var manualDuration = "25"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Break down").font(.system(size: 14, weight: .semibold, design: .rounded))
                Spacer()
                Button("Close") { vm.showBreakdown = false }.buttonStyle(.bordered).controlSize(.small)
            }
            if vm.breakdownLoading {
                HStack { ProgressView().scaleEffect(0.8); Text("Asking AI…").font(.system(size: 11)).foregroundStyle(.secondary) }
            }
            if let err = vm.breakdownError {
                Text(err).font(.system(size: 11, weight: .medium)).foregroundStyle(.orange).lineLimit(2)
            }
            if !vm.breakdownSuggestions.isEmpty {
                Text("AI suggestions").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
                ForEach(vm.breakdownSuggestions, id: \.title) { s in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            Text("\(s.estimatedDuration)m").font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Add") { vm.stageSuggestion(s) }.buttonStyle(.bordered).controlSize(.small)
                    }.padding(6).background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
                }
            }
            Text("Next actions").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            ForEach(Array(vm.breakdownChildren.enumerated()), id: \.offset) { idx, child in
                HStack {
                    Text(child.title).font(.system(size: 12)).lineLimit(1)
                    Spacer()
                    Text("\(child.durationMinutes)m").font(.system(size: 10)).foregroundStyle(.secondary)
                    Button(role: .destructive, action: { vm.removeStaged(at: idx) }) { Image(systemName: "trash").font(.system(size: 10)) }.buttonStyle(.plain).foregroundStyle(.red.opacity(0.7))
                }.padding(6).background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.06)))
            }
            HStack(spacing: 8) {
                TextField("New action title", text: $manualTitle).textFieldStyle(.roundedBorder).font(.system(size: 12))
                TextField("m", text: $manualDuration).frame(width: 50).textFieldStyle(.roundedBorder).font(.system(size: 12))
                Button("Add") {
                    if let d = Int(manualDuration), !manualTitle.isEmpty {
                        vm.stageManual(title: manualTitle, duration: d); manualTitle = ""; manualDuration = "25"
                    }
                }.buttonStyle(.borderedProminent).controlSize(.small).disabled(manualTitle.isEmpty)
            }
            HStack {
                Spacer()
                Button("Cancel") { vm.showBreakdown = false }.buttonStyle(.bordered).controlSize(.small)
                Button("Break down") { vm.confirmBreakdown(); vm.showBreakdown = false }.buttonStyle(.borderedProminent).controlSize(.small).disabled(vm.breakdownChildren.isEmpty)
            }
        }.padding(16).frame(width: 420)
    }
}
