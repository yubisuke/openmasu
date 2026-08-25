# M7 Deep-Link Operator Checklist

This checklist records operator evidence that synthetic CI cannot establish. Keep real hosts, package names, signing fingerprints, Apple team identifiers, campaigns, destinations, device identifiers, and validation records outside this public repository. Record only a dated pass/fail and an opaque private evidence reference here if the repository policy explicitly permits it.

- [ ] **DL-V-1 — Android verification on real devices.** Confirm `adb shell pm get-app-links <package>` reports `verified` after installation from a real track. Record propagation delay, whether forced re-verification was needed, and results on Android 11 and Android 12 or later.
- [ ] **DL-V-2 — Android deferred end to end.** Tap a real measurement link, install from Play, and confirm first-launch delivery without a network lookup. Reinstall and privately record which referrer Play returns. Record the longest referrer that survived intact.
- [ ] **DL-V-3 — One-week deferred coverage.** Measure the real-install distribution of `install.deferred_deep_link_status` for at least one week.
- [ ] **DL-V-4 — iOS Universal Links on a real device.** Test Safari, Messages, and one third-party app; verify same-domain Safari behavior; confirm Apple CDN association-file retrieval; record propagation delay. Do not infer iOS deferred support from this test.
- [ ] **DL-V-5 — Association-file propagation.** Add a second synthetic test app in the private deployment and record Android and Apple propagation while confirming the first app remains valid. Do not test removal on a production host.
- [ ] **DL-V-6 — App Store submission.** Submit a sample with Associated Domains enabled and no `?mode=developer`; record any reviewer question privately.
- [ ] **DL-V-7 — Unity export.** Export from the UPM package on each supported Unity line and verify Android intent forwarding and iOS entitlement injection without hand-editing.
- [ ] **DL-V-8 — Four-week re-engagement observation.** Record the ratio of `deep_link_open` events to clicks and the share with `deep_link_install_click_reused`. Treat a high reuse share as design input, not as a closed synthetic test.

None of these items is satisfied by a green GitHub Actions run. OpenMasu provides deterministic direct deep linking on Android and iOS and deterministic deferred delivery on Android only. It does not provide iOS deferred deep linking.
