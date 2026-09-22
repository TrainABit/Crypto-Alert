import SwiftUI

struct PlanBadge: View {
    let plan: Plan

    var body: some View {
        Text(plan == .pro ? "PRO" : "FREE")
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(plan == .pro ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.15), in: Capsule())
            .foregroundStyle(plan == .pro ? Color.accentColor : Color.secondary)
    }
}

struct ProLockLabel: View {
    var body: some View {
        Label("Pro", systemImage: "lock.fill")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.accentColor)
    }
}

struct PriceText: View {
    let quote: PriceQuote?

    var body: some View {
        if let quote {
            HStack(spacing: 6) {
                Text(PriceFormatter.string(quote.price))
                    .monospacedDigit()
                if let change = quote.change24h {
                    Text(PriceFormatter.percent(change))
                        .font(.caption)
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
            }
        } else {
            Text("—").foregroundStyle(.secondary)
        }
    }
}
