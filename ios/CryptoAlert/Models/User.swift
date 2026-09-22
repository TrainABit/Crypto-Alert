import Foundation

enum Plan: String, Codable {
    case free, pro
}

struct User: Codable, Equatable {
    let id: String
    var plan: Plan
    var planExpiresAt: Date?
    var appleLinked: Bool
    let createdAt: Date
}

struct PlanLimits: Codable, Equatable {
    let id: Plan
    let maxActiveAlerts: Int
    let repeatAlerts: Bool
    let conditionKinds: [String]
    let minCooldownMinutes: Int
    let pushesPerHour: Int

    func allows(_ condition: AlertCondition) -> Bool {
        conditionKinds.contains(condition.kind)
    }
}

struct AuthResponse: Decodable {
    let token: String
    let user: User
    let limits: PlanLimits
}

struct MeResponse: Decodable {
    struct Counts: Decodable {
        let activeAlerts: Int
        let devices: Int
    }

    let user: User
    let limits: PlanLimits
    let counts: Counts
}

struct BillingResponse: Decodable {
    let plan: Plan
    let expiresAt: Date?
    let user: User
    let limits: PlanLimits
}
