import SwiftUI

struct AlertListView: View {
    @Environment(AppModel.self) private var model
    @State private var showCreate = false
    @State private var prefillSymbol: String?

    private var active: [PriceAlert] { model.alerts.filter { $0.status == .active } }
    private var paused: [PriceAlert] { model.alerts.filter { $0.status == .paused } }
    private var done: [PriceAlert] { model.alerts.filter { $0.status == .triggered } }

    var body: some View {
        NavigationStack {
            Group {
                if model.alerts.isEmpty {
                    ContentUnavailableView {
                        Label("No alerts yet", systemImage: "bell.badge")
                    } description: {
                        Text("Get a push the moment a coin crosses your price.")
                    } actions: {
                        Button("Create your first alert") { showCreate = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        if !model.notifications.isEnabled {
                            NotificationsOffBanner()
                        }
                        section("Watching", active)
                        section("Paused", paused)
                        section("Done", done)
                        Section {
                            NavigationLink("History") { AlertHistoryView() }
                        } footer: {
                            planFooter
                        }
                    }
                }
            }
            .navigationTitle("Alerts")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showCreate = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New alert")
                }
            }
            .refreshable {
                await model.refreshAlerts()
                await model.refreshPrices()
            }
            .sheet(isPresented: $showCreate) {
                CreateAlertView(initialSymbol: prefillSymbol)
            }
            .sheet(item: Binding(
                get: { model.selectedAlertID.flatMap { id in model.alerts.first { $0.id == id } } },
                set: { model.selectedAlertID = $0?.id }
            )) { alert in
                AlertDetailView(alert: alert)
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ alerts: [PriceAlert]) -> some View {
        if !alerts.isEmpty {
            Section(title) {
                ForEach(alerts) { alert in
                    AlertRowView(alert: alert, quote: model.prices[alert.symbol])
                        .contentShape(Rectangle())
                        .onTapGesture { model.selectedAlertID = alert.id }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await model.delete(alert) }
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                        .swipeActions(edge: .leading) {
                            if alert.status == .active {
                                Button { Task { await model.setPaused(alert, true) } } label: { Label("Pause", systemImage: "pause.fill") }
                                    .tint(.orange)
                            } else {
                                Button { Task { await model.setPaused(alert, false) } } label: { Label("Resume", systemImage: "play.fill") }
                                    .tint(.green)
                            }
                        }
                }
            }
        }
    }

    private var planFooter: some View {
        Group {
            if let limits = model.limits, let user = model.user {
                HStack {
                    Text("\(model.activeAlertCount) of \(limits.maxActiveAlerts) active alerts · \(user.plan == .pro ? "Pro" : "Free plan")")
                    if user.plan == .free {
                        Button("Upgrade") { model.presentPaywall(reason: nil) }
                            .font(.footnote.weight(.semibold))
                    }
                }
            }
        }
    }
}

struct NotificationsOffBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Notifications are off", systemImage: "bell.slash.fill")
                    .font(.headline)
                Text("Alerts can't reach you until notifications are allowed for Crypto Alert.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if model.notifications.authorizationStatus == .notDetermined {
                    Button("Allow notifications") { Task { await model.notifications.requestAuthorization() } }
                        .buttonStyle(.borderedProminent)
                } else if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                    Link("Open Settings", destination: url)
                        .buttonStyle(.borderedProminent)
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.orange.opacity(0.12))
    }
}
