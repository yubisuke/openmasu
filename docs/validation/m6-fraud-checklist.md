# M6 fraud operator checklist

Automated gates use synthetic inputs only. Record every result outside this public repository when it contains traffic, provider tokens, project identifiers, network references, or customer data.

The shipped M6b code is the server boundary and observation-mode queue. Its CI adapters consume synthetic decoded responses. Configure `OPENMASU_INTEGRITY_PROVIDER` and the provider-specific HTTPS endpoint only after the operator-owned verifier, project, and credentials have been validated; an empty endpoint produces `unavailable` and never a fraud action.

- [ ] Confirm the sign distribution of Play server referrer-click time minus install-begin time on authorized traffic before changing F-R-1 beyond `flag`.
- [ ] Measure missing and zero Play timestamps by app and version.
- [ ] Review CTIT and source-day thresholds against authorized traffic; do not copy raw samples into this repository.
- [ ] Confirm whether `source_rate_class` remains useful behind carrier NAT and shared proxies; disable it if it is noise.
- [ ] Review every `exclude` and expired quarantine during the initial observation period.
- [ ] Confirm JSON/CSV chargeback rows are accepted by the intended network process without adding identifying fields.
- [ ] Validate Play Integrity in an operator-owned Play project and on authorized physical devices.
- [ ] Validate App Attest enrollment and assertions in an operator-owned Apple project and on authorized physical devices.
- [ ] Exercise provider timeout, 429, 5xx, quota exhaustion, key rotation, and recovery without changing metrics.
- [ ] Confirm production TLS, external secret custody, log retention, backup handling, alerting, and incident response.

Unverified by code completion: real traffic accuracy, real-device farms, reset fraud, provider false-positive rates, provider quotas, live key rotation, network acceptance, and cross-advertiser intelligence.
