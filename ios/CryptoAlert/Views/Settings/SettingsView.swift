import AuthenticationServices
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            List {
                Section("Plan") {
                    HStack {
                        Text(model.isPro ? "Crypto Alert Pro" : "Free plan")
                        Spacer()
                        PlanBadge(plan: model.user?.plan ?? .free)
                    }
                    if let expires = model.user?.planExpiresAt {
                        LabeledContent("Renews or ends", value: expires.formatted(date: .abbreviated, time: .omitted))
                    }
                    if !model.isPro {
                        Button("Upgrade to Pro") { model.presentPaywall() }
                    }
                    Button("Restore purchases") { Task { await model.store.restore(); await model.refreshMe() } }
                }

                Section {
                    if model.user?.appleLinked == true {
                        Label("Signed in with Apple", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.secondary)
                    } else {
                        SignInWithAppleButton(.signIn) { request in
                            request.requestedScopes = [.email]
                        } onCompletion: { result in
                            if case .success(let authorization) = result,
                               let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                               let data = credential.identityToken,
                               let token = String(data: data, encoding: .utf8) {
                                Task { await model.signInWithApple(identityToken: token) }
                            }
                        }
                        .frame(height: 44)
                        .listRowInsets(EdgeInsets())
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text(model.user?.appleLinked == true
                         ? "Your alerts follow your Apple ID to a new phone."
                         : "Sign in to keep your alerts when you switch phones. Without it, alerts live on this device only.")
                }

                Section("Notifications") {
                    LabeledContent("Status", value: model.notifications.isEnabled ? "On" : "Off")
                    if model.notifications.authorizationStatus == .notDetermined {
                        Button("Allow notifications") { Task { await model.notifications.requestAuthorization() } }
                    } else if !model.notifications.isEnabled, let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        Link("Open notification settings", destination: url)
                    }
                    if let error = model.notifications.lastRegistrationError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }

                Section("About") {
                    Link("Privacy Policy", destination: AppConfig.privacyPolicyURL)
                    Link("Terms of Use", destination: AppConfig.termsURL)
                    LabeledContent("Version", value: AppConfig.appVersion)
                    Text(AppConfig.disclaimer).font(.footnote).foregroundStyle(.secondary)
                }

                Section {
                    Button("Delete account", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Removes your alerts, history and subscription record from our servers. Purchases stay with your Apple ID.")
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete everything", role: .destructive) { Task { await model.deleteAccount() } }
                Button("Cancel", role: .cancel) {}
            }
            .task { await model.notifications.refreshStatus() }
        }
    }
}
