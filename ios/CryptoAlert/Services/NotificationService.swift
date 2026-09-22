import Foundation
import UIKit
import UserNotifications

/// Notification permission, APNs registration and taps on delivered alerts.
@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    /// Must match the `category` the backend puts in the push payload.
    static let category = "PRICE_ALERT"
    static let openAction = "OPEN_ALERT"
    static let pauseAction = "PAUSE_ALERT"

    var onDeviceToken: ((String) -> Void)?
    var onOpenAlert: ((String) -> Void)?
    var onAction: ((String, String) -> Void)?

    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    private(set) var deviceToken: String?
    private(set) var lastRegistrationError: String?

    func configure() {
        UNUserNotificationCenter.current().delegate = self
        registerCategories()
        Task { await refreshStatus() }
    }

    private func registerCategories() {
        let open = UNNotificationAction(identifier: Self.openAction, title: "Open", options: [.foreground])
        let pause = UNNotificationAction(identifier: Self.pauseAction, title: "Pause alert", options: [])
        let category = UNNotificationCategory(identifier: Self.category, actions: [open, pause], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    /// Ask in context, right after the user creates their first alert. Time-sensitive delivery comes from the entitlement.
    @discardableResult
    func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshStatus()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            return granted
        } catch {
            lastRegistrationError = error.localizedDescription
            return false
        }
    }

    func registerForRemoteNotificationsIfAuthorized() async {
        await refreshStatus()
        if authorizationStatus == .authorized || authorizationStatus == .provisional || authorizationStatus == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func deviceTokenReceived(_ hex: String) {
        deviceToken = hex
        lastRegistrationError = nil
        onDeviceToken?(hex)
    }

    func registrationFailed(_ error: Error) {
        lastRegistrationError = error.localizedDescription
    }

    var isEnabled: Bool {
        authorizationStatus == .authorized || authorizationStatus == .provisional || authorizationStatus == .ephemeral
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let alertID = userInfo["alertId"] as? String else { return }
        let action = response.actionIdentifier
        await MainActor.run {
            if action == UNNotificationDefaultActionIdentifier || action == Self.openAction {
                onOpenAlert?(alertID)
            } else {
                onAction?(action, alertID)
            }
        }
    }
}
