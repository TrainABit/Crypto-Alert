import Foundation
import Observation
import UserNotifications

/// Root state for the app: session, user, alerts, prices and the paywall.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var user: User?
    private(set) var limits: PlanLimits?
    private(set) var activeAlertCount = 0
    private(set) var alerts: [PriceAlert] = []
    private(set) var events: [AlertEvent] = []
    private(set) var prices: [String: PriceQuote] = [:]
    private(set) var catalogue: [SymbolEntry] = []

    var showPaywall = false
    var paywallReason: String?
    var selectedAlertID: String?
    var errorMessage: String?

    let api: APIClient
    let store = StoreManager()
    let notifications = NotificationService.shared

    static let marketSymbols = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "TON"]

    init(api: APIClient = APIClient()) {
        self.api = api
    }

    var isPro: Bool { user?.plan == .pro }

    // MARK: - Lifecycle

    func start() async {
        notifications.onDeviceToken = { [weak self] hex in
            Task { await self?.registerDevice(hex) }
        }
        notifications.onOpenAlert = { [weak self] id in
            self?.selectedAlertID = id
        }
        notifications.onAction = { [weak self] action, alertID in
            Task { await self?.handleNotificationAction(action, alertID: alertID) }
        }
        store.onVerifiedTransaction = { [weak self] jws in
            await self?.syncTransaction(jws)
        }
        store.start()
        await bootstrapSession()
    }

    private func bootstrapSession() async {
        phase = .loading
        do {
            if let token = SessionStore.load() {
                await api.setToken(token)
                do {
                    apply(try await api.me())
                } catch APIError.unauthorized {
                    SessionStore.delete()
                    try await signUpAnonymously()
                }
            } else {
                try await signUpAnonymously()
            }
            phase = .ready
            await refreshAll()
            await notifications.registerForRemoteNotificationsIfAuthorized()
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func signUpAnonymously() async throws {
        let auth = try await api.signUpAnonymously()
        SessionStore.save(auth.token)
        await api.setToken(auth.token)
        user = auth.user
        limits = auth.limits
    }

    private func apply(_ me: MeResponse) {
        user = me.user
        limits = me.limits
        activeAlertCount = me.counts.activeAlerts
    }

    // MARK: - Loading

    func refreshAll() async {
        await refreshMe()
        await refreshAlerts()
        await loadCatalogue()
        await refreshPrices()
        await refreshEvents()
    }

    func refreshMe() async {
        do { apply(try await api.me()) } catch { report(error) }
    }

    func refreshAlerts() async {
        do { alerts = try await api.alerts() } catch { report(error) }
    }

    func refreshEvents() async {
        do { events = try await api.events() } catch { report(error) }
    }

    func loadCatalogue() async {
        guard catalogue.isEmpty else { return }
        do { catalogue = try await api.symbols() } catch { report(error) }
    }

    func refreshPrices() async {
        let symbols = Set(alerts.map(\.symbol)).union(Self.marketSymbols)
        do {
            let fresh = try await api.prices(symbols: Array(symbols).sorted())
            prices.merge(fresh) { _, new in new }
        } catch {
            report(error)
        }
    }

    // MARK: - Alerts

    /// Returns true when the alert was created. Plan violations open the paywall instead of showing an error.
    @discardableResult
    func createAlert(_ draft: AlertDraft) async -> Bool {
        do {
            let response = try await api.createAlert(draft)
            alerts.insert(response.alert, at: 0)
            if let quote = response.currentPrice { prices[quote.symbol] = quote }
            activeAlertCount += 1
            if notifications.authorizationStatus == .notDetermined {
                // The first alert is the moment the permission makes sense to the user.
                await notifications.requestAuthorization()
            }
            return true
        } catch let error as APIError where error.needsUpgrade {
            paywallReason = error.localizedDescription
            showPaywall = true
            return false
        } catch {
            report(error)
            return false
        }
    }

    func update(_ alert: PriceAlert, patch: AlertPatch) async {
        do {
            let updated = try await api.updateAlert(id: alert.id, patch: patch)
            replace(updated)
            await refreshMe()
        } catch let error as APIError where error.needsUpgrade {
            paywallReason = error.localizedDescription
            showPaywall = true
        } catch {
            report(error)
        }
    }

    func setPaused(_ alert: PriceAlert, _ paused: Bool) async {
        await update(alert, patch: AlertPatch(status: paused ? .paused : .active))
    }

    func delete(_ alert: PriceAlert) async {
        do {
            try await api.deleteAlert(id: alert.id)
            alerts.removeAll { $0.id == alert.id }
            await refreshMe()
        } catch {
            report(error)
        }
    }

    private func replace(_ alert: PriceAlert) {
        if let index = alerts.firstIndex(where: { $0.id == alert.id }) {
            alerts[index] = alert
        } else {
            alerts.insert(alert, at: 0)
        }
    }

    private func handleNotificationAction(_ action: String, alertID: String) async {
        if alerts.isEmpty { await refreshAlerts() }
        guard let alert = alerts.first(where: { $0.id == alertID }) else { return }
        switch action {
        case NotificationService.pauseAction:
            await setPaused(alert, true)
        default:
            selectedAlertID = alertID
        }
        await refreshEvents()
    }

    // MARK: - Account

    func signInWithApple(identityToken: String) async {
        do {
            let auth = try await api.signInWithApple(identityToken: identityToken)
            SessionStore.save(auth.token)
            await api.setToken(auth.token)
            user = auth.user
            limits = auth.limits
            await refreshAll()
            await notifications.registerForRemoteNotificationsIfAuthorized()
        } catch {
            report(error)
        }
    }

    func deleteAccount() async {
        do {
            try await api.deleteAccount()
        } catch {
            report(error)
            return
        }
        SessionStore.delete()
        await api.setToken(nil)
        alerts = []
        events = []
        await bootstrapSession()
    }

    private func registerDevice(_ hex: String) async {
        do {
            try await api.registerDevice(token: hex, environment: AppConfig.apnsEnvironment, appVersion: AppConfig.appVersion)
        } catch {
            report(error)
        }
    }

    // MARK: - Billing

    private func syncTransaction(_ jws: String) async {
        do {
            let response = try await api.submitTransaction(jws: jws)
            user = response.user
            limits = response.limits
        } catch {
            report(error)
        }
    }

    func presentPaywall(reason: String? = nil) {
        paywallReason = reason
        showPaywall = true
    }

    private func report(_ error: Error) {
        if case APIError.unauthorized = error {
            SessionStore.delete()
            Task { await bootstrapSession() }
            return
        }
        errorMessage = error.localizedDescription
    }
}
