# Crypto Alert iOS app

SwiftUI, iOS 17+, StoreKit 2, Sign in with Apple, time-sensitive push notifications.

## Generate and build

```bash
brew install xcodegen
xcodegen generate
open CryptoAlert.xcodeproj
```

`project.yml` is the source of truth; the `.xcodeproj`, `Info.plist` and entitlements file are
generated and ignored by git. Re-run `xcodegen generate` after adding files.

1. Signing & Capabilities: pick your team. The bundle id `com.trainabit.cryptoalert` must match
   `APNS_BUNDLE_ID` and `APPSTORE_BUNDLE_ID` on the server.
2. Run on a **device**. The simulator cannot receive APNs pushes.
3. Debug builds call `http://localhost:8080`; run `npm run dev` in `backend/` on the same Mac.
   Point `AppConfig.apiBaseURL` at your host for release builds.
4. The scheme loads `Config/CryptoAlert.storekit`, so the paywall works with local StoreKit testing.
   Remove it from the scheme to test against the App Store sandbox. If Xcode complains about the
   file, recreate it with File › New › File › StoreKit Configuration File and copy the product ids.

## Structure

```
CryptoAlert/
  App/          entry point, AppDelegate (APNs token), AppModel (root state), AppConfig
  Models/       Codable types mirroring the API
  Networking/   APIClient (actor), SessionStore (Keychain)
  Services/     NotificationService, StoreManager (StoreKit 2)
  Views/        Alerts, Markets, Paywall, Settings, shared components
  Resources/    Assets, PrivacyInfo.xcprivacy
  Config/       StoreKit configuration for local testing
```

## Behaviour worth knowing

- The app starts with an anonymous account so the first alert takes seconds; Sign in with Apple
  later links it, or merges it into an existing account on a new phone.
- Notification permission is requested right after the first alert is created, with the
  time-sensitive option, never at launch.
- Plan limits come from the server. A `402` with `upgrade: true` opens the paywall with the reason.
- Purchases attach the user id as `appAccountToken`; verified transactions are sent to the backend,
  which owns the entitlement.

## Not verified here

This scaffold was written without access to Xcode. Expect the first `xcodegen generate` and build to
surface small compiler complaints; the CI workflow in `.github/workflows/ios.yml` runs the build on
macOS so they show up early.
