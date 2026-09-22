import SwiftUI

struct CreateAlertView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    enum Kind: String, CaseIterable, Identifiable {
        case above = "Above", below = "Below", percent = "% change"
        var id: String { rawValue }
    }

    @State private var symbol: String
    @State private var kind: Kind = .above
    @State private var priceText = ""
    @State private var percent: Double = 5
    @State private var windowMinutes = 60
    @State private var direction: AlertCondition.Direction = .either
    @State private var repeats = false
    @State private var cooldownMinutes = 60
    @State private var note = ""
    @State private var isSaving = false

    private struct Choice: Identifiable {
        let label: String
        let minutes: Int
        var id: Int { minutes }
    }

    private let windows = [Choice(label: "15 min", minutes: 15), Choice(label: "1 h", minutes: 60), Choice(label: "4 h", minutes: 240), Choice(label: "24 h", minutes: 1440)]
    private let cooldowns = [Choice(label: "5 min", minutes: 5), Choice(label: "15 min", minutes: 15), Choice(label: "1 h", minutes: 60), Choice(label: "4 h", minutes: 240), Choice(label: "24 h", minutes: 1440)]

    init(initialSymbol: String? = nil) {
        _symbol = State(initialValue: initialSymbol ?? "BTC")
    }

    private var quote: PriceQuote? { model.prices[symbol] }
    private var limits: PlanLimits? { model.limits }

    private var condition: AlertCondition? {
        switch kind {
        case .above, .below:
            guard let price = Double(priceText.replacingOccurrences(of: ",", with: ".")), price > 0 else { return nil }
            return kind == .above ? .priceAbove(price: price) : .priceBelow(price: price)
        case .percent:
            return .percentChange(percent: percent, windowMinutes: windowMinutes, direction: direction)
        }
    }

    private var percentLocked: Bool { !(limits?.allows(.percentChange(percent: 1, windowMinutes: 1, direction: .up)) ?? true) }
    private var repeatLocked: Bool { !(limits?.repeatAlerts ?? true) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Coin") {
                    NavigationLink {
                        SymbolPickerView(selection: $symbol)
                    } label: {
                        HStack {
                            Text(symbol).font(.headline)
                            Spacer()
                            PriceText(quote: quote).foregroundStyle(.secondary)
                        }
                    }
                }

                Section("When") {
                    Picker("Type", selection: $kind) {
                        ForEach(Kind.allCases) { k in
                            if k == .percent && percentLocked {
                                Label(k.rawValue, systemImage: "lock.fill").tag(k)
                            } else {
                                Text(k.rawValue).tag(k)
                            }
                        }
                    }
                    .pickerStyle(.segmented)

                    switch kind {
                    case .above, .below:
                        HStack {
                            Text("Price (USD)")
                            TextField(quote.map { PriceFormatter.string($0.price) } ?? "0", text: $priceText)
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                        }
                        if let condition, condition.alreadyHolds(at: quote?.price) {
                            Label("Already true right now. You'll be notified the next time the price crosses this level.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    case .percent:
                        if percentLocked {
                            Button { model.presentPaywall(reason: "Percent-change alerts are a Pro feature.") } label: {
                                Label("Unlock percent-change alerts with Pro", systemImage: "sparkles")
                            }
                        } else {
                            Stepper(value: $percent, in: 0.5...100, step: 0.5) {
                                Text("Moves \(percent.formatted())%")
                            }
                            Picker("Within", selection: $windowMinutes) {
                                ForEach(windows) { Text($0.label).tag($0.minutes) }
                            }
                            Picker("Direction", selection: $direction) {
                                ForEach(AlertCondition.Direction.allCases) { Text($0.label).tag($0) }
                            }
                        }
                    }
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { repeats },
                        set: { newValue in
                            if newValue && repeatLocked {
                                model.presentPaywall(reason: "Repeating alerts are a Pro feature.")
                            } else {
                                repeats = newValue
                            }
                        }
                    )) {
                        HStack {
                            Text("Repeat")
                            if repeatLocked { ProLockLabel() }
                        }
                    }
                    if repeats {
                        Picker("At most once every", selection: $cooldownMinutes) {
                            ForEach(cooldowns.filter { $0.minutes >= (limits?.minCooldownMinutes ?? 1) }) { Text($0.label).tag($0.minutes) }
                        }
                    }
                    TextField("Note (optional)", text: $note)
                } footer: {
                    Text("One-shot alerts end after they fire. Repeating alerts re-arm once the price crosses back.")
                }
            }
            .navigationTitle("New alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await save() } }
                        .disabled(condition == nil || isSaving)
                }
            }
            .task(id: symbol) {
                if model.prices[symbol] == nil { await model.refreshPrices() }
            }
        }
    }

    private func save() async {
        guard let condition else { return }
        isSaving = true
        defer { isSaving = false }
        let draft = AlertDraft(
            symbol: symbol,
            condition: condition,
            repeats: repeats,
            cooldownMinutes: repeats ? cooldownMinutes : max(60, limits?.minCooldownMinutes ?? 60),
            note: note.isEmpty ? nil : note
        )
        if await model.createAlert(draft) { dismiss() }
    }
}

struct SymbolPickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private var entries: [SymbolEntry] {
        let supported = model.catalogue.filter(\.supported)
        guard !query.isEmpty else { return supported }
        let q = query.uppercased()
        return supported.filter { $0.symbol.contains(q) || $0.name.uppercased().contains(q) }
    }

    var body: some View {
        List {
            if !query.isEmpty, entries.isEmpty {
                Button("Use \(query.uppercased())") {
                    selection = query.uppercased()
                    dismiss()
                }
            }
            ForEach(entries) { entry in
                Button {
                    selection = entry.symbol
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(entry.symbol).font(.headline)
                            Text(entry.name).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        PriceText(quote: model.prices[entry.symbol]).foregroundStyle(.secondary)
                        if entry.symbol == selection { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                    }
                }
                .foregroundStyle(.primary)
            }
        }
        .searchable(text: $query, prompt: "Symbol or name")
        .navigationTitle("Choose a coin")
        .task { await model.loadCatalogue() }
    }
}
