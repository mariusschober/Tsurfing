import SwiftUI

struct ConflictsSheet: View {
    @ObservedObject var vm: ExecutionViewModel
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Sync Conflicts").font(.system(size: 14, weight: .semibold, design: .rounded))
                Spacer()
                Button("Close") { dismiss() }.buttonStyle(.bordered).controlSize(.small)
            }
            if vm.conflicts.isEmpty {
                Text("No conflicts — all synced.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                ForEach(vm.conflicts, id: \.id) { c in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(c.entityType):\(c.entityId)").font(.system(size: 11, weight: .semibold, design: .rounded))
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Local").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                                Text(describe(c.localPayload)).font(.system(size: 11)).lineLimit(2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Server").font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                                Text(describe(c.serverPayload)).font(.system(size: 11)).lineLimit(2)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        HStack(spacing: 8) {
                            Button("Keep local") { vm.resolveConflict(id: c.id, useLocal: true) }.buttonStyle(.borderedProminent).controlSize(.small).accessibilityLabel("Keep local").accessibilityIdentifier("keep-local-button")
                            Button("Use cloud") { vm.resolveConflict(id: c.id, useLocal: false) }.buttonStyle(.bordered).controlSize(.small).accessibilityLabel("Use cloud").accessibilityIdentifier("use-cloud-button")
                            Spacer()
                            Text("v\(c.serverVersion)").font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                    }.padding(8).background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.08))).overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.15), lineWidth: 1))
                }
            }
        }.padding(16).frame(width: 480)
    }

    private func describe(_ payload: AnyCodable) -> String {
        if let d = payload.value as? [String: Any], let title = d["title"] as? String { return title }
        if let s = payload.value as? String { return s }
        return stableJson(payload.value) ?? "—"
    }
}
