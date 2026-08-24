# Shared Ledger Android

This directory contains the Trusted Web Activity wrapper for the existing Shared Ledger PWA.

- Package: `com.xingleihuang.sharedledger`
- Version: `1.2.1` (`versionCode` 10201)
- Web origin: `https://xingleihuang850-lang.github.io`
- Start URL: `https://xingleihuang850-lang.github.io/shared-ledger/?source=pwa`
- Minimum Android version: Android 6.0 (API 23)

The APK is a signed Android launcher for the same hosted PWA. Web features and data-format updates continue to arrive through the PWA Service Worker; a new APK release is required only when native wrapper metadata, permissions, signing, or Android dependencies change.

Release signing material is intentionally excluded from Git. GitHub Actions reconstructs `release.keystore` from encrypted repository secrets and runs the Gradle release build. The public certificate fingerprint is listed in `twa-manifest.json` and in the account-level `/.well-known/assetlinks.json` file.

For a local signed build, provide these environment variables before running `./gradlew assembleRelease`:

- `ANDROID_KEYSTORE_PATH`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
