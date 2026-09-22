import SwiftUI

struct AlertRowView: View {
    let alert: PriceAlert
    let quote: PriceQuote?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(alert.title)
                    .font(.headline)
                Spacer()
                if alert.repeats {
                    Image(systemName: "repeat")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Repeats")
                }
            }
            HStack(spacing: 8) {
                PriceText(quote: quote)
                    .font(.subheadline)
                Text("·").foregroundStyle(.secondary)
                Text(alert.stateLabel)
                    .font(.subheadline)
                    .foregroundStyle(alert.status == .active && alert.armed ? Color.accentColor : .secondary)
            }
            if let last = alert.lastTriggeredAt {
                Text("Last fired \(last.formatted(.relative(presentation: .named)))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
