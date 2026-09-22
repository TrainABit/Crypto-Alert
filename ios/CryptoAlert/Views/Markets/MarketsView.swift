import SwiftUI

struct MarketsView: View {
    @Environment(AppModel.self) private var model
    @State private var createFor: String?

    var body: some View {
        NavigationStack {
            List(AppModel.marketSymbols, id: \.self) { symbol in
                HStack {
                    VStack(alignment: .leading) {
                        Text(symbol).font(.headline)
                        Text(model.catalogue.first { $0.symbol == symbol }?.name ?? "")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    PriceText(quote: model.prices[symbol])
                }
                .contentShape(Rectangle())
                .onTapGesture { createFor = symbol }
            }
            .navigationTitle("Markets")
            .refreshable { await model.refreshPrices() }
            .task {
                await model.refreshPrices()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(30))
                    await model.refreshPrices()
                }
            }
            .sheet(item: Binding(get: { createFor.map(SymbolBox.init) }, set: { createFor = $0?.symbol })) { box in
                CreateAlertView(initialSymbol: box.symbol)
            }
        }
    }

    private struct SymbolBox: Identifiable {
        let symbol: String
        var id: String { symbol }
    }
}
