import Foundation

/// Thin async client for the Crypto PriceAlert backend. All calls carry the session bearer token.
actor APIClient {
    private let baseURL: URL
    private let session: URLSession
    private var token: String?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = AppConfig.apiBaseURL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        configuration.waitsForConnectivity = true
        session = URLSession(configuration: configuration)

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            if let date = iso.date(from: value) ?? isoPlain.date(from: value) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Bad date \(value)"))
        }
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
    }

    func setToken(_ token: String?) {
        self.token = token
    }

    // MARK: Auth

    func signUpAnonymously() async throws -> AuthResponse {
        try await send("POST", "/v1/auth/anonymous")
    }

    func signInWithApple(identityToken: String) async throws -> AuthResponse {
        try await send("POST", "/v1/auth/apple", body: encode(["identityToken": identityToken]))
    }

    func logout() async throws {
        try await sendNoContent("POST", "/v1/auth/logout")
    }

    func me() async throws -> MeResponse {
        try await send("GET", "/v1/me")
    }

    func deleteAccount() async throws {
        try await sendNoContent("DELETE", "/v1/me")
    }

    // MARK: Devices

    func registerDevice(token: String, environment: String, appVersion: String) async throws {
        struct Body: Encodable { let token: String; let environment: String; let appVersion: String }
        struct Response: Decodable { struct Device: Decodable { let token: String }; let device: Device }
        let _: Response = try await send("PUT", "/v1/devices", body: encode(Body(token: token, environment: environment, appVersion: appVersion)))
    }

    // MARK: Alerts

    func alerts() async throws -> [PriceAlert] {
        let response: AlertsResponse = try await send("GET", "/v1/alerts")
        return response.alerts
    }

    func createAlert(_ draft: AlertDraft) async throws -> CreateAlertResponse {
        try await send("POST", "/v1/alerts", body: encode(draft))
    }

    func updateAlert(id: String, patch: AlertPatch) async throws -> PriceAlert {
        let response: AlertResponse = try await send("PATCH", "/v1/alerts/\(id)", body: encode(patch))
        return response.alert
    }

    func deleteAlert(id: String) async throws {
        try await sendNoContent("DELETE", "/v1/alerts/\(id)")
    }

    func events(limit: Int = 50) async throws -> [AlertEvent] {
        let response: EventsResponse = try await send("GET", "/v1/alerts/events", query: [URLQueryItem(name: "limit", value: String(limit))])
        return response.events
    }

    // MARK: Prices

    func prices(symbols: [String]) async throws -> [String: PriceQuote] {
        guard !symbols.isEmpty else { return [:] }
        let response: PricesResponse = try await send("GET", "/v1/prices", query: [URLQueryItem(name: "symbols", value: symbols.joined(separator: ","))])
        var result: [String: PriceQuote] = [:]
        for (symbol, quote) in response.prices {
            if let quote { result[symbol] = quote }
        }
        return result
    }

    func symbols() async throws -> [SymbolEntry] {
        let response: SymbolsResponse = try await send("GET", "/v1/symbols")
        return response.symbols
    }

    // MARK: Billing

    func submitTransaction(jws: String) async throws -> BillingResponse {
        try await send("POST", "/v1/billing/transactions", body: encode(["jws": jws]))
    }

    // MARK: Plumbing

    private func encode<Body: Encodable>(_ body: Body) throws -> Data {
        try encoder.encode(body)
    }

    private func send<Response: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Response {
        let (data, _) = try await perform(method, path, query: query, body: body)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private func sendNoContent(_ method: String, _ path: String) async throws {
        _ = try await perform(method, path)
    }

    private func perform(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var components = URLComponents(url: baseURL.appending(path: relative), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport(URLError(.badServerResponse)) }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            let payload = try? decoder.decode(APIErrorBody.self, from: data)
            throw APIError.http(
                status: http.statusCode,
                code: payload?.error.code ?? "http_\(http.statusCode)",
                message: payload?.error.message ?? "Request failed (\(http.statusCode))",
                upgrade: payload?.error.upgrade ?? false
            )
        }
        return (data, http)
    }
}
