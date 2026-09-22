import StoreKit
import SwiftUI

struct PaywallView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Product?

    private var store: StoreManager { model.store }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Image(systemName: "bell.and.waves.left.and.right.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(Color.accentColor)
                        Text("Crypto Alert Pro")
                            .font(.largeTitle.bold())
                        if let reason = model.paywallReason {
                            Text(reason)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .padding(.top)

                    VStack(alignment: .leading, spacing: 12) {
                        feature("infinity", "Unlimited alerts", "Watch every coin you care about.")
                        feature("repeat", "Repeating alerts", "Re-arm automatically after every crossing.")
                        feature("percent", "Percent-change alerts", "Catch pumps and dumps within minutes or hours.")
                        feature("bolt.fill", "Short cooldowns", "Down to one minute between alerts.")
                    }
                    .padding(.horizontal)

                    if store.products.isEmpty {
                        ProgressView(store.isLoading ? "Loading plans…" : "Plans unavailable")
                            .padding()
                    } else {
                        VStack(spacing: 10) {
                            ForEach(store.products, id: \.id) { product in
                                planRow(product)
                            }
                        }
                        .padding(.horizontal)
                    }

                    Button {
                        guard let product = selected ?? store.yearly ?? store.products.first else { return }
                        Task {
                            if await store.purchase(product, userID: model.user?.id) {
                                await model.refreshMe()
                                dismiss()
                            }
                        }
                    } label: {
                        Text(callToAction)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.products.isEmpty || store.isPurchasing)
                    .padding(.horizontal)

                    Button("Restore purchases") {
                        Task {
                            await store.restore()
                            await model.refreshMe()
                            if model.isPro { dismiss() }
                        }
                    }
                    .font(.footnote)

                    if let error = store.lastError {
                        Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center).padding(.horizontal)
                    }

                    VStack(spacing: 6) {
                        Text("Subscriptions renew automatically until cancelled in Settings › Apple ID › Subscriptions. Lifetime is a one-time purchase.")
                        Text(AppConfig.disclaimer)
                        HStack {
                            Link("Privacy Policy", destination: AppConfig.privacyPolicyURL)
                            Text("·")
                            Link("Terms of Use", destination: AppConfig.termsURL)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                }
                .padding(.bottom, 24)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } }
            }
            .task {
                if store.products.isEmpty { await store.loadProducts() }
                if selected == nil { selected = store.yearly ?? store.products.first }
            }
        }
    }

    private var callToAction: String {
        guard let product = selected ?? store.yearly else { return "Continue" }
        if let offer = product.subscription?.introductoryOffer, offer.paymentMode == .freeTrial {
            return "Start free trial"
        }
        return "Continue with \(product.displayName)"
    }

    private func feature(_ icon: String, _ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .frame(width: 28)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private func planRow(_ product: Product) -> some View {
        let isSelected = (selected ?? store.yearly)?.id == product.id
        return Button {
            selected = product
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName).font(.headline)
                    Text(planSubtitle(product)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(product.displayPrice).font(.headline.monospacedDigit())
            }
            .padding()
            .background(isSelected ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(isSelected ? Color.accentColor : .clear, lineWidth: 2))
        }
        .buttonStyle(.plain)
    }

    private func planSubtitle(_ product: Product) -> String {
        guard let subscription = product.subscription else { return "One-time purchase, yours forever" }
        var text = subscription.subscriptionPeriod.unit == .year ? "per year" : "per month"
        if let offer = subscription.introductoryOffer, offer.paymentMode == .freeTrial {
            text += " · \(offer.period.value) \(offer.period.unit == .week ? "week" : "day") free trial"
        }
        return text
    }
}
