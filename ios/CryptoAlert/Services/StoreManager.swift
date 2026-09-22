import Foundation
import Observation
import StoreKit

/// StoreKit 2 purchases. Every verified transaction is forwarded to the backend, which owns the entitlement.
@MainActor
@Observable
final class StoreManager {
    private(set) var products: [Product] = []
    private(set) var purchasedProductIDs: Set<String> = []
    private(set) var isLoading = false
    private(set) var isPurchasing = false
    private(set) var lastError: String?

    /// Receives the JWS representation of verified transactions for server-side verification.
    var onVerifiedTransaction: ((String) async -> Void)?

    private var updatesTask: Task<Void, Never>?

    func start() {
        guard updatesTask == nil else { return }
        updatesTask = Task { await listenForTransactions() }
        Task {
            await loadProducts()
            await refreshEntitlements()
        }
    }

    func stop() {
        updatesTask?.cancel()
        updatesTask = nil
    }

    var hasLocalEntitlement: Bool {
        !purchasedProductIDs.isDisjoint(with: AppConfig.Products.all)
    }

    var monthly: Product? { products.first { $0.id == AppConfig.Products.monthly } }
    var yearly: Product? { products.first { $0.id == AppConfig.Products.yearly } }
    var lifetime: Product? { products.first { $0.id == AppConfig.Products.lifetime } }

    func loadProducts() async {
        isLoading = true
        defer { isLoading = false }
        do {
            products = try await Product.products(for: AppConfig.Products.all)
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Purchases a product. The user id travels along as the appAccountToken so App Store Server Notifications can be mapped to the user.
    @discardableResult
    func purchase(_ product: Product, userID: String?) async -> Bool {
        isPurchasing = true
        defer { isPurchasing = false }
        do {
            var options: Set<Product.PurchaseOption> = []
            if let userID, let uuid = UUID(uuidString: userID) {
                options.insert(.appAccountToken(uuid))
            }
            let result = try await product.purchase(options: options)
            switch result {
            case .success(let verification):
                let transaction = try checkVerified(verification)
                await onVerifiedTransaction?(verification.jwsRepresentation)
                await transaction.finish()
                await refreshEntitlements()
                return true
            case .userCancelled, .pending:
                return false
            @unknown default:
                return false
            }
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func restore() async {
        do {
            try await AppStore.sync()
        } catch {
            lastError = error.localizedDescription
        }
        await refreshEntitlements()
    }

    func refreshEntitlements() async {
        var ids: Set<String> = []
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            guard transaction.revocationDate == nil else { continue }
            ids.insert(transaction.productID)
            await onVerifiedTransaction?(result.jwsRepresentation)
        }
        purchasedProductIDs = ids
    }

    private func listenForTransactions() async {
        for await result in Transaction.updates {
            guard case .verified(let transaction) = result else { continue }
            await onVerifiedTransaction?(result.jwsRepresentation)
            await transaction.finish()
            await refreshEntitlements()
        }
    }

    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let value):
            return value
        }
    }
}
