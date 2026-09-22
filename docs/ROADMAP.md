# Roadmap

## Phase 0: foundation (this repository)

- Server-side alert engine with Binance and CoinGecko feeds, outlier and staleness guards, hysteresis,
  cooldowns, per-user rate limits.
- APNs delivery with token auth and dead-token cleanup.
- Postgres persistence, anonymous accounts, Sign in with Apple, account deletion.
- StoreKit 2 verification and App Store Server Notifications, plan enforcement.
- SwiftUI app scaffold: alerts, markets, create flow, paywall, settings, notification handling.

## Phase 1: beta on TestFlight

- Generate the Xcode project, fix whatever the compiler flags, add the app icon.
- Deploy the backend with Postgres and the APNs key; confirm a push arrives on a real device.
- Sandbox purchase, renewal and expiry verified against server logs.
- Instrument tick-to-push latency and delivery rate; surface both on `/healthz`.
- Crash reporting and privacy-friendly analytics for the funnel.

## Phase 2: launch

- Rich notifications: Notification Service Extension attaching a sparkline image and the 24 h change.
- Home Screen and Lock Screen widgets for tracked coins (WidgetKit).
- Live Activity while a coin is within 1 % of an alert threshold.
- App Store page, screenshots, keywords, Small Business Program, DSA trader status.

## Phase 3: growth and retention

- Apple Watch app and complications.
- More alert types: volume spikes, all-time highs, moving-average and RSI crossovers, new listings,
  funding rate for perps, gas price.
- Email and Telegram delivery as Pro channels.
- Portfolio value alerts (manual holdings first, read-only exchange keys later).
- Siri and Shortcuts: "Alert me when Bitcoin hits 100k" through App Intents.
- Localization for the top ten storefronts.

## Phase 4: platform

- Split the engine by symbol shards for horizontal scale.
- Multiple exchange sources with automatic failover and a consensus price.
- Webhook and API tier for communities.
- Android client sharing the same backend.
