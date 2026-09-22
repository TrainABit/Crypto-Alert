import Foundation

struct PriceQuote: Codable, Equatable {
    let symbol: String
    let price: Double
    let at: Date
    let source: String
    let change24h: Double?
}

struct PricesResponse: Decodable {
    let prices: [String: PriceQuote?]
}

struct SymbolEntry: Codable, Identifiable, Equatable {
    let symbol: String
    let name: String
    let supported: Bool
    var id: String { symbol }
}

struct SymbolsResponse: Decodable {
    let symbols: [SymbolEntry]
    let customSymbolsAllowed: Bool
}

struct AlertEvent: Codable, Identifiable, Equatable {
    let id: String
    let alertId: String?
    let symbol: String
    let price: Double
    let title: String
    let body: String
    let firedAt: Date
    let delivered: Bool
}

struct EventsResponse: Decodable {
    let events: [AlertEvent]
}

enum PriceFormatter {
    /// USD with decimals that suit the magnitude, matching the backend's formatting.
    static func string(_ price: Double) -> String {
        let magnitude = abs(price)
        let fraction: ClosedRange<Int>
        if magnitude >= 10_000 { fraction = 0...0 } else if magnitude >= 1 { fraction = 2...2 } else if magnitude >= 0.01 { fraction = 2...4 } else { fraction = 2...8 }
        return price.formatted(.currency(code: "USD").precision(.fractionLength(fraction)))
    }

    static func percent(_ value: Double) -> String {
        let sign = value > 0 ? "+" : ""
        return sign + value.formatted(.number.precision(.fractionLength(2))) + "%"
    }
}
