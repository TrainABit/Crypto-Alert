# App Store checklist for a crypto alert app

## Apple Developer setup

- [ ] Apple Developer Program membership (organization enrollment if the company name should show).
- [ ] App id with Push Notifications, Sign in with Apple and Time Sensitive Notifications capabilities.
- [ ] APNs key (.p8) created under Keys; note the key id and team id for `APNS_*`.
- [ ] Sign in with Apple enabled for the app id; the bundle id is the identity token audience.
- [ ] In-app purchases created in App Store Connect; ids match `PRO_PRODUCT_IDS`.
- [ ] App Store Server Notifications V2 URL set for sandbox and production.
- [ ] Sandbox tester accounts for purchase testing on device.
- [ ] Small Business Program enrollment.

## Review guidelines that bite crypto apps

- Guideline 3.1.5(b): no on-device mining, no ICO facilitation, no crypto rewards for tasks. Price
  and alert apps are fine. Trading needs exchange licensing, so link out instead.
- Guideline 5.1.1(v): in-app account deletion when accounts exist. `DELETE /v1/me` and the Settings
  button cover it.
- Guideline 4.8: Sign in with Apple, or an equally private option, whenever other social logins are
  offered. We offer only Sign in with Apple plus anonymous use.
- Guideline 3.1.2: subscription terms visible on the paywall (auto-renew text, privacy and terms links).
- Provide a demo account or note in App Review notes that the app works without login.
- Keep marketing free of "guaranteed", "returns", "signals" or "advice". The disclaimer in the app
  and on the store page says the app is not financial advice.

## Privacy and legal

- [ ] Privacy manifest (`PrivacyInfo.xcprivacy`): declares user id, device token and purchase history
      as app-functionality data, no tracking. Update it if you add analytics SDKs.
- [ ] App Privacy labels in App Store Connect matching the manifest.
- [ ] Privacy policy and terms URLs live and linked from the app (`AppConfig`).
- [ ] EU Digital Services Act trader status in App Store Connect before selling in the EU.
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption` is set to false (only HTTPS is used).
- [ ] GDPR: account deletion, data minimization (we store user id, device token, alerts, events, subscriptions).

## Notifications

- [ ] Ask for permission after the first alert is created, never at launch (already implemented).
- [ ] Time-sensitive entitlement and interruption level so alerts cut through Focus modes.
- [ ] Do not plan around Critical Alerts; Apple rarely grants the entitlement to price apps.
- [ ] Test on a physical device: the simulator receives no APNs pushes.
- [ ] Make the "notifications are off" state loud in the app (banner and Settings link exist).

## Before submitting

- [ ] Release build points at the production API (`AppConfig.apiBaseURL`) over HTTPS.
- [ ] `APPSTORE_ENVIRONMENT=Production` and `APPSTORE_APP_APPLE_ID` set on the server.
- [ ] TestFlight round with real purchases in sandbox and a renewal cycle observed in the server logs.
- [ ] App icon, screenshots for 6.7" and 6.1" devices, keyword research for "crypto alert", "bitcoin price alert".
- [ ] Support URL and contact email.
