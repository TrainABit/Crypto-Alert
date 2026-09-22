# Architecture

## The one decision everything follows from

iOS does not let an app run continuously in the background. Background App Refresh is opportunistic
and often hours apart; silent pushes are throttled. An alert app that evaluates prices on the phone
misses alerts, and users leave after the first miss. So:

- the **backend** watches prices and evaluates alerts around the clock;
- the **app** creates alerts, shows prices and history, handles payment and receives pushes.

Everything in `backend/` exists to make one path fast and honest: price tick in, notification out,
with a record of what happened either way.

## Data flow

```
Binance WebSocket (miniTicker, ~1 tick/s/symbol)  ─┐
                                                   ├─► FeedManager ─► AlertEngine.handleTick
CoinGecko REST (60 s poll, long tail, fallback)   ─┘        │
                                                            ├─ PriceBook.update   (outlier hold, source priority, history)
                                                            ├─ evaluateAlert      (pure: fire / rearm / none)
                                                            └─ fire ─► store.updateAlert ─► APNs ─► store.recordEvent
```

**Feeds** (`src/feeds`) know nothing about alerts. Binance streams USDT pairs for every tracked symbol
over one connection, re-subscribes after reconnects, and seeds 25 hours of 5-minute candles the
first time a symbol is tracked so window alerts work immediately. CoinGecko polls the curated
catalogue once a minute and backs off on 429. Both expose a one-off `quote()` so the create-alert
screen can show a price for a coin nobody is tracking yet.

**PriceBook** (`src/domain/price-book.ts`) holds the latest price and a sampled 24-hour history per
symbol. Three guards live here because they must apply to every source:

- a tick more than 15 % away from the last accepted price is held until a second tick confirms it,
  so a flash wick or a bad print cannot fire alerts;
- a lower-priority source (CoinGecko) cannot override a primary source (Binance) that ticked within
  the last 30 seconds;
- out-of-order and non-finite ticks are dropped.

**Evaluator** (`src/engine/evaluator.ts`) is a pure function of one alert and the current price. Rules:

- only active alerts fire, and only when armed and outside the cooldown;
- after firing, an alert is disarmed; a repeating alert re-arms once the price crosses back by the
  hysteresis band (0.5 % by default) so a price oscillating on the threshold does not spam;
- percent-change alerts re-arm once the move has retraced to half the threshold;
- an alert created while its condition is already true starts disarmed and fires on the next crossing.
  The API tells the app, and the app tells the user.

**Engine** (`src/engine/engine.ts`) keeps every active alert in memory indexed by symbol, so a tick
costs no database round trip unless something fires. State changes are written through immediately;
the index is rebuilt from the store every 30 seconds and right after API changes. In-memory state is
mutated before any `await` so a second tick cannot double-fire an alert. Per-user pushes are capped
per hour (20 free, 240 Pro) and dead device tokens are removed on APNs `410`/`BadDeviceToken`.

**Push** (`src/push`) speaks HTTP/2 to APNs with token-based auth (ES256 JWT, refreshed every 50
minutes). Payloads use the `time-sensitive` interruption level so they break through Focus modes,
carry a `thread-id` per coin, a `collapse-id` per alert and `mutable-content` for a future rich
notification extension.

**Store** (`src/store`) is an interface with two implementations: in-memory for development and
tests, Postgres for production. The Postgres implementation is tested against PGlite in-process, so
CI needs no database server. Deleting a user cascades to sessions, devices, alerts, events and
subscriptions, which is what App Review's account-deletion rule requires.

**Billing** (`src/billing`) verifies StoreKit 2 transaction JWS and App Store Server Notifications
with Apple's official library against Apple's root certificates, then recomputes the user's plan from
all of their subscriptions. The app attaches the user id as `appAccountToken` at purchase time so a
server notification can be mapped to a user even before the app has reported the transaction.

**API** (`src/api`) is a small Hono app. Sessions are opaque bearer tokens stored server side.
Anonymous accounts let a user create the first alert within seconds; Sign in with Apple links the
account or merges an anonymous one into an existing one. Plan limits are enforced here and in the
engine, never only in the app.

## Operational notes

- One backend process is enough for tens of thousands of alerts. Scale reads with more API replicas
  and keep exactly one engine process; splitting the engine by symbol is the next step.
- Instrument the latency from price tick to APNs `200`. That number is the product.
- `GET /healthz` exposes engine counters (ticks, fired, delivered, rate-limited, errors).
- USDT pairs stand in for USD. For most users the difference is invisible; show the quote asset if it ever matters.
