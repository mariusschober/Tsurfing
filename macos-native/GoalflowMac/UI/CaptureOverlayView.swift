import SwiftUI

struct CaptureOverlayView: View {
    @ObservedObject var vm: CaptureViewModel
    @FocusState private var focused: Bool
    var onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            inputField
            if vm.showNotes { notesField }
            if vm.showDatePicker { datePickerSection }
            else { previewChips }
            if let err = vm.displayError {
                Text(err).font(.system(size: 11, weight: .medium)).foregroundStyle(.red).lineLimit(2)
            }
            actionRow
            hintRow
        }
        .padding(16)
        .frame(width: 520)
        .background(panelBG)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
        .shadow(color: Color.black.opacity(0.20), radius: 24, x: 0, y: 12)
        .onAppear { focused = true; vm.checkPrivacy() }
    }

    private var panelBG: some View {
        ZStack {
            if #available(macOS 13.0, *) {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.ultraThinMaterial)
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(nsColor: .windowBackgroundColor))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.fill").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.accentColor)
            Text("Quick Capture").font(.system(size: 11, weight: .semibold, design: .rounded)).tracking(0.7).textCase(.uppercase).foregroundStyle(.secondary)
            Spacer()
            if vm.parsed.isFrog { Text("FROG").font(.system(size: 10, weight: .bold, design: .rounded)).foregroundStyle(.white).padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Color.green)) }
            Button(action: { onDismiss(); vm.cancel() }) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary.opacity(0.6)).font(.system(size: 14))
            }.buttonStyle(.plain).keyboardShortcut(.cancelAction)
        }
    }

    private var inputField: some View {
        HStack(spacing: 8) {
            Image(systemName: "pencil").foregroundStyle(.secondary)
            TextField("What needs doing?  e.g. Draft proposal @25m #focus 2026-09-01", text: $vm.rawText)
                    .accessibilityLabel("Capture title")
                    .accessibilityIdentifier("capture-title-field")
                .textFieldStyle(.plain)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .focused($focused)
                .onSubmit { _ = vm.submitAdd() ? onDismiss() : () }
                .submitLabel(.done)
            if !vm.rawText.isEmpty {
                Button(action: { vm.rawText = "" }) { Image(systemName: "xmark").foregroundStyle(.secondary) }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.08), lineWidth: 1))
    }

    private var notesField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Notes / URLs").font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(.secondary).tracking(0.5).textCase(.uppercase)
            TextEditor(text: $vm.notes)
                .frame(height: 60)
                .font(.system(size: 12))
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08), lineWidth: 1))
        }
    }

    private var datePickerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Select date").font(.system(size: 11, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
            Picker("Mode", selection: $vm.isMonthMode) {
                Text("Exact day").tag(false)
                Text("Future month").tag(true)
            }.pickerStyle(.segmented).labelsHidden()
            if vm.isMonthMode {
                monthPicker
            } else {
                DatePicker("Day", selection: $vm.selectedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .labelsHidden()
            }
            HStack {
                Button("Cancel") { vm.showDatePicker = false }.buttonStyle(.bordered).controlSize(.small)
                Spacer()
                Button("Confirm date") {
                    // Just hides picker, keeps selection; next Enter will create
                    vm.showDatePicker = false
                }.buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.08), lineWidth: 1))
    }

    private var monthPicker: some View {
        // Simple next 12 months list filtered > current month
        let months = nextMonths()
        return Picker("Month", selection: $vm.selectedMonth) {
            ForEach(months, id: \.self) { m in Text(m).tag(m) }
        }
        .pickerStyle(.menu)
        .onAppear {
            if vm.selectedMonth.isEmpty { vm.selectedMonth = months.first ?? "" }
        }
    }

    private func nextMonths() -> [String] {
        var res: [String] = []
        let cal = Calendar.current
        let todayStr = makeTodayString()
        let currentMonth = String(todayStr.prefix(7))
        for i in 1...12 {
            if let d = cal.date(byAdding: .month, value: i, to: Date()) {
                let f = DateFormatter(); f.dateFormat = "yyyy-MM"; f.timeZone = .current; f.locale = Locale(identifier: "en_US_POSIX")
                let m = f.string(from: d)
                if m > currentMonth { res.append(m) }
            }
        }
        return res
    }

    private var previewChips: some View {
        HStack(spacing: 8) {
            // title preview
            Label(vm.titlePreview, systemImage: "doc.text")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            if vm.parsed.durationMinutes != nil {
                Chip(text: vm.durationPreview, color: .orange)
            } else {
                Chip(text: "25m", color: .secondary.opacity(0.8))
            }
            ForEach(vm.parsed.tags, id: \.self) { tag in Chip(text: "#\(tag)", color: .accentColor) }
            if let sf = vm.effectiveScheduledFor {
                Chip(text: sf, color: .green)
            } else {
                Chip(text: "Select date", color: .red)
            }
            if let t = vm.parsed.scheduledTime { Chip(text: t, color: .blue) }
            if !vm.parsed.urls.isEmpty { Chip(text: "🔗\(vm.parsed.urls.count)", color: .purple) }
        }
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button(action: { if vm.submitAdd() { onDismiss() } }) {
                Label("ADD", systemImage: "plus")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 8)
                    .background(Capsule().fill(Color.accentColor))
            }.buttonStyle(.plain).keyboardShortcut(.defaultAction)
            .disabled(!vm.canSubmit && !vm.showDatePicker)
            .opacity((!vm.canSubmit && !vm.showDatePicker) ? 0.5 : 1)

            Button(action: { if vm.submitAction() { onDismiss() } }) {
                Label("ACTION", systemImage: "bolt.fill")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 8)
                    .background(Capsule().fill(Color.green))
            }.buttonStyle(.plain)
            .keyboardShortcut("a", modifiers: [.command])
            .disabled(!vm.canSubmit && !vm.showDatePicker)
            .opacity((!vm.canSubmit && !vm.showDatePicker) ? 0.5 : 1)

            Spacer()
            Button(action: { vm.toggleNotes() }) {
                Label(vm.showNotes ? "Hide notes" : "Notes ⌘↵", systemImage: "note.text")
                    .font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
            }.buttonStyle(.plain).keyboardShortcut(.return, modifiers: [.command])
        }
    }

    private var hintRow: some View {
        HStack(spacing: 8) {
            Text("Enter → ADD  •  ⌘+Enter → Notes  •  ⌘+A → ACTION  •  Esc → Dismiss")
                .font(.system(size: 10, weight: .regular, design: .rounded)).foregroundStyle(.tertiary)
            Spacer()
            if vm.isScreenSharing {
                Label("Privacy — hidden while sharing", systemImage: "eye.slash").font(.system(size: 10, weight: .medium)).foregroundStyle(.orange)
            }
        }
    }
}

private struct Chip: View {
    var text: String
    var color: Color
    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold, design: .rounded)).foregroundStyle(color).padding(.horizontal, 6).padding(.vertical, 3).background(Capsule().fill(color.opacity(0.12))).overlay(Capsule().stroke(color.opacity(0.18), lineWidth: 1))
    }
}
