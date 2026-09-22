import SwiftUI

struct AlertDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let alert: PriceAlert

    private var live: PriceAlert { model.alerts.first { $0.id == alert.id } ?? alert }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Condition", value: live.title)
                    LabeledContent("Current price") { PriceText(quote: model.prices[live.symbol]) }
                    LabeledContent("State", value: live.stateLabel)
                    LabeledContent("Repeats", value: live.repeats ? "Every \(live.cooldownMinutes) min at most" : "Once")
                    if let note = live.note, !note.isEmpty {
                        LabeledContent("Note", value: note)
                    }
                    LabeledContent("Fired", value: "\(live.triggerCount)×")
                    if let last = live.lastTriggeredAt {
                        LabeledContent("Last fired", value: last.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                Section {
                    if live.status == .active {
                        Button("Pause") { Task { await model.setPaused(live, true) } }
                    } else {
                        Button(live.status == .triggered ? "Arm again" : "Resume") { Task { await model.setPaused(live, false) } }
                    }
                    Button("Delete", role: .destructive) {
                        Task {
                            await model.delete(live)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(live.symbol)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}
