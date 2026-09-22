import Foundation

enum AlertCondition: Codable, Equatable, Hashable {
    case priceAbove(price: Double)
    case priceBelow(price: Double)
    case percentChange(percent: Double, windowMinutes: Int, direction: Direction)

    enum Direction: String, Codable, CaseIterable, Identifiable {
        case up, down, either
        var id: String { rawValue }
        var label: String {
            switch self {
            case .up: return "Up"
            case .down: return "Down"
            case .either: return "Either way"
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, price, percent, windowMinutes, direction
    }

    var kind: String {
        switch self {
        case .priceAbove: return "price_above"
        case .priceBelow: return "price_below"
        case .percentChange: return "percent_change"
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "price_above":
            self = .priceAbove(price: try container.decode(Double.self, forKey: .price))
        case "price_below":
            self = .priceBelow(price: try container.decode(Double.self, forKey: .price))
        case "percent_change":
            self = .percentChange(
                percent: try container.decode(Double.self, forKey: .percent),
                windowMinutes: try container.decode(Int.self, forKey: .windowMinutes),
                direction: try container.decode(Direction.self, forKey: .direction)
            )
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown condition kind \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .priceAbove(let price), .priceBelow(let price):
            try container.encode(price, forKey: .price)
        case .percentChange(let percent, let windowMinutes, let direction):
            try container.encode(percent, forKey: .percent)
            try container.encode(windowMinutes, forKey: .windowMinutes)
            try container.encode(direction, forKey: .direction)
        }
    }

    /// Mirrors the server: true when the condition already holds, so the alert waits for the next crossing.
    func alreadyHolds(at currentPrice: Double?) -> Bool {
        guard let currentPrice else { return false }
        switch self {
        case .priceAbove(let price): return currentPrice >= price
        case .priceBelow(let price): return currentPrice <= price
        case .percentChange: return false
        }
    }
}

enum AlertStatus: String, Codable {
    case active, paused, triggered
}

struct PriceAlert: Codable, Identifiable, Equatable, Hashable {
    let id: String
    var symbol: String
    var quote: String
    var condition: AlertCondition
    var repeats: Bool
    var cooldownMinutes: Int
    var status: AlertStatus
    var armed: Bool
    var note: String?
    var title: String
    var lastTriggeredAt: Date?
    var triggerCount: Int
    var createdAt: Date
    var updatedAt: Date

    private enum CodingKeys: String, CodingKey {
        case id, symbol, quote, condition, cooldownMinutes, status, armed, note, title, lastTriggeredAt, triggerCount, createdAt, updatedAt
        case repeats = "repeat"
    }

    /// Short state description for lists.
    var stateLabel: String {
        switch status {
        case .paused: return "Paused"
        case .triggered: return "Done"
        case .active: return armed ? "Watching" : "Waiting for the price to cross back"
        }
    }
}

/// Body for POST /v1/alerts.
struct AlertDraft: Encodable {
    var symbol: String
    var condition: AlertCondition
    var repeats: Bool = false
    var cooldownMinutes: Int = 60
    var note: String?

    private enum CodingKeys: String, CodingKey {
        case symbol, condition, cooldownMinutes, note
        case repeats = "repeat"
    }
}

/// Body for PATCH /v1/alerts/:id. Nil fields are left untouched by the server.
struct AlertPatch: Encodable {
    var condition: AlertCondition?
    var repeats: Bool?
    var cooldownMinutes: Int?
    var status: AlertStatus?
    var note: String?

    private enum CodingKeys: String, CodingKey {
        case condition, cooldownMinutes, status, note
        case repeats = "repeat"
    }
}

struct CreateAlertResponse: Decodable {
    let alert: PriceAlert
    let currentPrice: PriceQuote?
}

struct AlertsResponse: Decodable {
    let alerts: [PriceAlert]
}

struct AlertResponse: Decodable {
    let alert: PriceAlert
}
