import Foundation

struct APIErrorBody: Decodable {
    struct Payload: Decodable {
        let code: String
        let message: String
        let upgrade: Bool?
    }

    let error: Payload
}

enum APIError: LocalizedError {
    case unauthorized
    case http(status: Int, code: String, message: String, upgrade: Bool)
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Your session has expired."
        case .http(_, _, let message, _): return message
        case .transport(let error): return error.localizedDescription
        case .decoding: return "The server sent something unexpected."
        }
    }

    /// True when the server says a Pro upgrade would lift the restriction.
    var needsUpgrade: Bool {
        if case .http(_, _, _, let upgrade) = self { return upgrade }
        return false
    }

    var code: String? {
        if case .http(_, let code, _, _) = self { return code }
        return nil
    }
}
