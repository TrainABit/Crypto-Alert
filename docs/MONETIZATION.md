# Monetization

## Model

Freemium with a Pro subscription, plus a lifetime option. Limits are enforced on the server
(`backend/src/domain/plan.ts`), the app only mirrors them for the UI.

| | Free | Pro |
|---|---|---|
| Active alerts | 3 | 200 |
| Alert types | above / below | plus percent change (and future indicator, volume, listing alerts) |
| Repeating alerts | no | yes |
| Shortest cooldown | 60 min | 1 min |
| Pushes per hour | 20 | 240 |
| Later | | widgets, Live Activities, Watch, email and Telegram delivery |

Suggested launch prices, to be tested per region through App Store Connect price points:

| Product id | Price | Notes |
|---|---|---|
| `…pro.monthly` | 3.99 USD | anchor, most people should pick yearly |
| `…pro.yearly` | 27.99 USD | 7-day free trial, default selection on the paywall |
| `…pro.lifetime` | 59.99 USD | non-consumable; attracts users who hate subscriptions |

## Where the paywall goes

1. When the user hits a limit (alert count, repeat, percent change). The API answers `402` with
   `upgrade: true`, the app opens the paywall with the reason. This is already wired.
2. Right after the first alert fires. That is the moment the product proved itself. Show it once,
   never at launch.
3. A quiet entry point in Settings and in the alert list footer.

Track the funnel from install to notification permission, first alert created, first alert fired,
paywall viewed, trial started, paid. Use a privacy-friendly analytics tool; the privacy manifest
declares no tracking and it should stay that way.

## StoreKit setup

- Products live in App Store Connect under one subscription group "Pro" plus the lifetime
  non-consumable. The ids must match `PRO_PRODUCT_IDS` on the server and `AppConfig.Products` in the app.
- The app uses StoreKit 2 directly (`StoreManager.swift`), attaches the user id as
  `appAccountToken`, and sends every verified transaction JWS to `POST /v1/billing/transactions`.
- Configure App Store Server Notifications V2 in App Store Connect to
  `https://<your host>/v1/billing/appstore-notifications` for both sandbox and production. Renewals,
  expirations, grace periods, refunds and revocations then keep the plan correct without the app.
- Enroll in the **App Store Small Business Program** before launch: 15 % commission instead of 30 %
  while under one million USD a year. Apple is merchant of record and handles VAT.
- RevenueCat is a reasonable alternative to the server-side verification if you want paywall A/B
  tests and Android later; keep the `EntitlementService` as the source of truth either way.

## Additional revenue lines

- **Exchange referral links.** A "Buy on …" button beside each coin with affiliate codes from
  Binance, Coinbase, Kraken or Bybit pays recurring commissions. Link out, never trade in-app:
  in-app trading needs exchange licensing under guideline 3.1.5.
- **No banner ads at launch.** They undercut the premium feel of a utility app and pay little until
  the free tier is large. Revisit only with volume.
- **Webhook or API tier** for Discord and Telegram communities once the alert engine is proven.
- Stay away from selling signals or predictions. That drifts into financial advice and App Review
  trouble.

## Pricing hygiene

- Localize prices with App Store price points, do not hard-code.
- Offer the free trial on yearly only; monthly without trial keeps the anchor honest.
- Watch trial-to-paid and month-two retention before touching prices.
