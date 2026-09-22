import SwiftUI

struct AlertHistoryView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if model.events.isEmpty {
                ContentUnavailableView("Nothing fired yet", systemImage: "clock", description: Text("Alerts that fire show up here, even if the push did not arrive."))
            }
            ForEach(model.events) { event in
                VStack(alignment: .leading, spacing: 4) {
                    Text(event.title).font(.headline)
                    Text(event.body).font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Text(event.firedAt.formatted(date: .abbreviated, time: .shortened))
                        if !event.delivered {
                            Label("Not delivered", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("History")
        .refreshable { await model.refreshEvents() }
        .task { await model.refreshEvents() }
    }
}
