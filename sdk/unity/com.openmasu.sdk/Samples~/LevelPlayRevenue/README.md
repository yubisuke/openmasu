# Optional LevelPlay impression revenue binding

Import this sample only in a host project that has resolved the LevelPlay 9.5+
Unity package. It uses the per-ad `OnAdImpressionDataReady` API and is excluded
from the standard OpenMasu runtime assembly. The host owns ad initialization,
loading, display and destruction; this binding does none of those operations.

After initializing the OpenMasu client, enable collection and wait for a
successful `UpdateConsent(Granted or NotRequired, policyVersion, completion)`
acknowledgement. Keep calling `PumpCallbacks()` on the Unity main thread.
Create one `OpenMasuLevelPlayAdapter(client)` and subscribe each rewarded,
interstitial or banner object, passing the same explicit ad-unit ID used to
construct that object. Subscribe before loading or showing it.

Call `Unsubscribe(ad)` before the host destroys an ad. Repeating the same
subscription does not attach a second handler; conflicting reuse is refused.
Dispose the binding when its owner is disabled or destroyed. It supports up to
64 simultaneous ad objects. Already observed, queued revenue is not cancelled
merely by unsubscribing; consent withdrawal, collection changes, installation
reset and client disposal separately invalidate pending managed observations.

Callbacks may run on a background thread. Only minimal fields are read; the
existing dispatcher performs native delivery on the Unity main thread. Null,
negative, non-finite or overflowing revenue is refused, not converted to zero.
Observed zero remains zero. USD micros are rounded half-even. `BID`, `RATE` and
`CPM` become `exact`, `publisher_defined` and `estimated`; other precision is
`undefined`. All observations remain `client_estimated`, not verified revenue.
Auction IDs become opaque stable references, not logs. Repeated callbacks reuse
the same event identity; no end-to-end exactly-once guarantee is made.

`RejectedCount` is a local aggregate of invalid or not-enabled callbacks.
Successful managed dispatch is not native durability, server acceptance or
provider completeness. Do not use raw `AllData`, campaign names, device IDs or
provider credentials in this sample or a public repository.

The repository's managed compile probe uses a clearly identified API shim. It
does not establish resolution or execution of the actual provider SDK in a
consumer project. Real callbacks, platform builds and revenue completeness
remain operator checks. Editor mock ads do not generate ILR evidence.

Primary sources checked 2026-10-25:

- [Unity ILR integration](https://docs.unity.com/en-us/grow/levelplay/sdk/unity/impression-level-revenue-integration)
- [ILR fields and precision](https://docs.unity.com/en-us/grow/levelplay/platform/fundamentals/impression-level-revenue-sdk-api)

These sources do not establish live account permission, waterfall eligibility,
delivery completeness or billing agreement. No real account is used by tests.
