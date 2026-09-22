import Foundation

enum AppConfig {
    static let bundleID = Bundle.main.bundleIdentifier ?? "com.trainabit.cryptoalert"

    /// Debug builds talk to a backend on the Mac (see backend/README). Release builds need the real host.
    static var apiBaseURL: URL {
        #if DEBUG
        return URL(string: "http://localhost:8080")!
        #else
        return URL(string: "https://api.cryptoalert.example.com")!
        #endif
    }

    /// Debug builds get sandbox APNs tokens; TestFlight and App Store builds get production tokens.
    static var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    static var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    enum Products {
        static let monthly = "com.trainabit.cryptoalert.pro.monthly"
        static let yearly = "com.trainabit.cryptoalert.pro.yearly"
        static let lifetime = "com.trainabit.cryptoalert.pro.lifetime"
        static let all = [monthly, yearly, lifetime]
    }

    static let privacyPolicyURL = URL(string: "https://example.com/crypto-alert/privacy")!
    static let termsURL = URL(string: "https://example.com/crypto-alert/terms")!
    static let disclaimer = "Crypto Alert notifies you about market prices. It is not financial advice, and prices can be delayed or wrong."
}
