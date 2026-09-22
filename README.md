# Crypto Alert

Price and market alerts for crypto, delivered as push notifications to iOS. This repository holds the
two halves of the product:

| Part | What it is | Status |
|---|---|---|
| [`backend/`](backend) | TypeScript alert engine, price feeds, APNs delivery, subscription enforcement and the REST API | Builds, 70 tests, live smoke test passes against CoinGecko (the Binance stream needs an egress Binance does not geo-block) |
| [`ios/`](ios) | SwiftUI app: alerts, markets, paywall (StoreKit 2), Sign in with Apple, notifications | Scaffold; needs Xcode on a Mac to build and sign |

Why the split matters: iOS suspends apps in the background, so a phone cannot watch prices itself. The
server watches every tracked coin and pushes the moment a condition holds; the app is the place to
create alerts, see prices and pay. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

## Run the backend in five minutes

```bash
cd backend
npm install
npm run dev            # in-memory store, pushes are logged, real Binance + CoinGecko prices
```

Then in another terminal:

```bash
TOKEN=$(curl -s -X POST localhost:8080/v1/auth/anonymous | jq -r .token)
curl -s -X POST localhost:8080/v1/alerts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"symbol":"BTC","condition":{"kind":"price_below","price":1000000}}' | jq
curl -s "localhost:8080/v1/prices?symbols=BTC,ETH" -H "Authorization: Bearer $TOKEN" | jq
```

`npm test` runs the unit and contract tests (Postgres is exercised through PGlite, no server needed).
`npm run build && npm run smoke` boots the compiled server and checks live prices end to end.

For a real deployment copy `backend/.env.example` to `backend/.env`, fill in Postgres, the APNs key and
the App Store settings, then `docker compose up --build`. All settings are documented in the example file.

## Build the app

```bash
cd ios
brew install xcodegen
xcodegen generate
open CryptoAlert.xcodeproj
```

Set your team in Signing & Capabilities, keep the bundle id in sync with `APNS_BUNDLE_ID`, and run on a
device (push notifications do not work in the simulator). The scheme uses a local StoreKit
configuration so the paywall works without App Store Connect. Details in [ios/README.md](ios/README.md).

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a price tick becomes a notification, and why it is built this way
- [docs/MONETIZATION.md](docs/MONETIZATION.md): plans, prices, paywall placement, StoreKit and revenue lines
- [docs/APP_STORE_CHECKLIST.md](docs/APP_STORE_CHECKLIST.md): everything App Review and the law expect from a crypto app
- [docs/ROADMAP.md](docs/ROADMAP.md): what to build next, in order

## API at a glance

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/anonymous` | device-only account, returns a bearer token |
| POST | `/v1/auth/apple` | Sign in with Apple; links or merges the anonymous account |
| GET / DELETE | `/v1/me` | profile, plan limits, counts; delete account |
| PUT / DELETE | `/v1/devices` | register the APNs token |
| GET / POST | `/v1/alerts` | list, create (plan limits enforced, returns the current price) |
| PATCH / DELETE | `/v1/alerts/:id` | edit, pause, resume, delete |
| GET | `/v1/alerts/events` | firing history |
| GET | `/v1/prices?symbols=BTC,ETH` | live prices with 24 h change |
| GET | `/v1/symbols` | curated catalogue with feed support |
| POST | `/v1/billing/transactions` | StoreKit 2 transaction JWS, verified server side |
| POST | `/v1/billing/appstore-notifications` | App Store Server Notifications V2 |
| GET | `/healthz` | engine statistics |

Errors are `{ "error": { "code", "message", "upgrade"? } }`. A plan limit answers with status 402 and
`upgrade: true` so the app can open the paywall.
