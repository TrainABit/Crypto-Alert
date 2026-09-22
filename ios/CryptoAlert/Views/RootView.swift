import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            switch model.phase {
            case .loading:
                ProgressView("Connecting…")
            case .failed(let message):
                ContentUnavailableView {
                    Label("Can't reach the server", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await model.start() } }
                        .buttonStyle(.borderedProminent)
                }
            case .ready:
                TabView {
                    AlertListView()
                        .tabItem { Label("Alerts", systemImage: "bell.fill") }
                    MarketsView()
                        .tabItem { Label("Markets", systemImage: "chart.line.uptrend.xyaxis") }
                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                }
            }
        }
        .sheet(isPresented: $model.showPaywall) {
            PaywallView()
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}
