#!/usr/bin/env python3
"""Independent Python evaluator for OpenMasu Contract v0.4 fixtures."""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import rfc8785

CONTRACT_VERSION = "0.4.0"
# Rule bundles and metric definitions retain their independent v0.3 identities.
REFERENCE_RULE_VERSION = "0.3.0"
ATTRIBUTION_BUNDLE_HASH = "2a6acdf35b3c649dc1e56d14cbc7436065118e4bb0ed1e7bd7b4604e834dce50"
APPLE_POSTBACK_BUNDLE_HASH = "91181289d7e6604c8a73b7e83d6950334db9bc1067b78ab25216ecaa24bcb896"
METRIC_DEFAULT_BUNDLE_HASH = "f765891ef3ac0337da9811cfb00f3883e3eece5a0ef3ec4ac23a6b2d0a24e443"
DAY_MS = 86_400_000


def bound_non_fraud_bundle(server: dict[str, Any], bundle_id: str, expected_hash: str) -> dict[str, str]:
    bound = server.get("non_fraud_rule_bundles", {}).get(bundle_id)
    if bound is not None and (
        bound.get("rule_bundle_id") != bundle_id
        or bound.get("rule_bundle_version") != REFERENCE_RULE_VERSION
        or bound.get("rule_bundle_hash") != expected_hash
        or bound.get("definition_digest") != expected_hash
    ):
        raise ValueError("non_fraud_rule_bundle_binding_mismatch")
    return {
        "rule_bundle_id": bundle_id,
        "rule_bundle_version": REFERENCE_RULE_VERSION,
        "rule_bundle_hash": expected_hash,
    }


def canonical(value: Any) -> str:
    return rfc8785.dumps(value).decode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


FRAUD_BUNDLE = {
    "id": "fraud-conservative",
    "version": "1.0.0",
    "layers": {"base": {
        "ctit_lower_bound_seconds": 10,
        "ctit_negative_rate_threshold": 0.05,
        "referrer_redirector_divergence_seconds": 300,
        "source_day_min_clicks": 1000,
        "source_day_cvr_median_multiplier": 0.2,
        "source_day_ctit_p50_min_seconds": 86400,
        "source_day_ctit_p95_p50_max_ratio": 3,
        "quarantine_hours": 72,
    }},
    "rules": [
        {"id": "transport-bot-prefetch-v1", "inputs": ["prefetch_signal"], "action": "exclude"},
        {"id": "transport-replay-v1", "inputs": ["replay_signal"], "action": "exclude"},
        {"id": "referrer-server-order-v1", "inputs": ["referrer_click_at_server", "install_begin_at_server"], "action": "flag"},
        {"id": "ctit-lower-bound-v1", "inputs": ["redirector_click_at", "install_begin_at_server"], "action": "flag"},
        {"id": "ctit-clock-anomaly-v1", "inputs": ["redirector_click_at", "install_begin_at_server"], "action": "allow"},
        {"id": "referrer-redirector-divergence-v1", "inputs": ["referrer_click_at_server", "redirector_click_at"], "action": "flag"},
        {"id": "source-day-click-flooding-v1", "inputs": ["source_day_aggregate"], "action": "flag"},
        {"id": "device-integrity-combination-v1", "inputs": ["integrity_verdict", "ctit"], "action": "flag"},
    ],
}
FRAUD_BUNDLE_HASH = digest(FRAUD_BUNDLE)


def fraud_parameter(bundle: dict[str, Any], name: str, fallback: float) -> float:
    value = bundle.get("layers", {}).get("base", {}).get(name, fallback)
    return float(value) if isinstance(value, (int, float)) else fallback


def fraud_action(bundle: dict[str, Any], rule_id: str, fallback: str) -> str:
    return next((rule["action"] for rule in bundle.get("rules", []) if rule.get("id") == rule_id), fallback)


def bound_fraud_bundle(server: dict[str, Any]) -> tuple[dict[str, Any], str] | None:
    if server.get("fraud_enabled") is False:
        return None
    bound = server.get("fraud_rule_bundle")
    if bound is None:
        return FRAUD_BUNDLE, FRAUD_BUNDLE_HASH
    definition = bound["definition"]
    bundle_hash = digest({
        "id": definition["id"], "version": definition["version"],
        "layers": definition["layers"], "rules": definition["rules"],
    })
    if bound.get("rule_bundle_id") != definition["id"] or bound.get("rule_bundle_version") != definition["version"]:
        raise ValueError("fraud_rule_bundle_identity_mismatch")
    if bound.get("definition_digest") != digest(definition):
        raise ValueError("fraud_rule_bundle_definition_digest_mismatch")
    if bound.get("rule_bundle_hash") != bundle_hash:
        raise ValueError("fraud_rule_bundle_hash_mismatch")
    return definition, bundle_hash


def quarantine_deadline(action: str, evaluated_at: str, bundle: dict[str, Any]) -> dict[str, str]:
    if action != "quarantine":
        return {}
    hours = fraud_parameter(bundle, "quarantine_hours", 72)
    return {"resolution_deadline_at": (timestamp(evaluated_at, "evaluated_at") + timedelta(hours=hours)).isoformat(timespec="milliseconds").replace("+00:00", "Z")}


class TimestampInvalidError(ValueError):
    """A contract timestamp failed exact calendar round-trip validation."""

    exit_code = 1


def timestamp(value: str | None, field: str) -> datetime:
    if not value:
        raise TimestampInvalidError(f"timestamp_invalid: {field}={value}")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError) as error:
        raise TimestampInvalidError(f"timestamp_invalid: {field}={value}") from error
    round_trip = parsed.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    if round_trip != value:
        raise TimestampInvalidError(f"timestamp_invalid: {field}={value}")
    return parsed


def utf16_key(value: str) -> tuple[int, ...]:
    encoded = value.encode("utf-16-le", errors="surrogatepass")
    return tuple(encoded[index] | (encoded[index + 1] << 8) for index in range(0, len(encoded), 2))


SortKey = Callable[[dict[str, Any]], tuple[str, ...]]


def sort_by_key(values: list[dict[str, Any]], key: SortKey) -> list[dict[str, Any]]:
    return sorted(values, key=lambda value: tuple(
        utf16_key(part) for part in (*key(value), digest(value))
    ))


def raw_record_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["record_id"], value["tenant_id"], value["app_id"], value["delivery_id"]


def delivery_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["delivery_id"], value["record_id"], value["tenant_id"], value["app_id"]


def logical_event_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["logical_event_id"], value["tenant_id"], value["app_id"]


def correction_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["correction_id"], value["tenant_id"], value["app_id"]


def privacy_request_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["privacy_request_id"], value["tenant_id"], value["app_id"]


def privacy_tombstone_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["privacy_request_id"], value["record_id"], value["tenant_id"], value["app_id"]


def attribution_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["attribution_id"], value["tenant_id"], value["app_id"]


def metric_run_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return (value["metric_run_id"],)


def fraud_decision_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return (value["fraud_decision_id"],)


def rejection_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["delivery_id"], value["record_id"], value["tenant_id"], value["app_id"]


def reconciliation_sort_key(value: dict[str, Any]) -> tuple[str, ...]:
    return value["reconciliation_id"], value["tenant_id"], value["app_id"]


def flatten_attempts(value: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if "batches" in value:
        for batch in value["batches"]:
            for record in batch["records"]:
                result.append({"server": batch["server_context"], "record": record, "batch_id": batch["batch_id"]})
    else:
        for record in value.get("records", []):
            result.append({"server": value["server_context"], "record": record, "batch_id": "batch-default"})
    return sorted(result, key=lambda item: (
        utf16_key(item["record"]["received_at"]), utf16_key(item["record"]["record_id"]),
        utf16_key(item["record"]["delivery_id"]), utf16_key(item["server"]["tenant_id"]),
        utf16_key(item["server"]["app_id"]), utf16_key(item["record"]["schema_version"]),
        utf16_key(digest(item["record"])),
    ))


def assert_import_provider_contexts(attempts: list[dict[str, Any]]) -> None:
    for attempt in attempts:
        record = attempt["record"]
        context = record["payload"].get("import_context")
        if not record["producer"].startswith("import:") or not context:
            continue
        if record["producer"] != f"import:{context['provider']}":
            raise ValueError("import_context.provider must match the authenticated import producer")


def assert_revenue_anchor_sources(attempts: list[dict[str, Any]]) -> None:
    for attempt in attempts:
        record = attempt["record"]
        if record["event_name"] != "ad_revenue" or record["payload"].get("anchor_source") is None:
            continue
        if not record["producer"].startswith("postback:"):
            raise ValueError("ad_revenue.anchor_source is limited to authenticated S2S postback producers")


def scope_key(attempt: dict[str, Any]) -> tuple[str, str, str, str]:
    server, record = attempt["server"], attempt["record"]
    return server["tenant_id"], server["app_id"], record["producer"], record["event_id"]


def evidence_key(tenant_id: str, app_id: str, record_id: str) -> tuple[str, str, str]:
    return tenant_id, app_id, record_id


def attempt_evidence_key(attempt: dict[str, Any]) -> tuple[str, str, str]:
    return evidence_key(
        attempt["server"]["tenant_id"],
        attempt["server"]["app_id"],
        attempt["record"]["record_id"],
    )


def attempt_decision_key(attempt: dict[str, Any]) -> tuple[str, ...]:
    # record_id is globally allocated by the server. Delivery context keeps a
    # malformed collision from overwriting another decision in this evaluator.
    return (
        attempt["batch_id"], attempt["server"]["tenant_id"], attempt["server"]["app_id"],
        attempt["record"]["delivery_id"], attempt["record"]["record_id"], attempt["record"]["schema_version"],
        digest(attempt["record"]),
    )


def decision_for(decisions: dict[tuple[str, ...], dict[str, Any]], attempt: dict[str, Any]) -> dict[str, Any]:
    try:
        return decisions[attempt_decision_key(attempt)]
    except KeyError as error:
        raise ValueError(f"missing decision: {attempt['record']['delivery_id']}") from error


def assert_installation_anchors(
    attempts: list[dict[str, Any]],
    decisions: dict[tuple[str, ...], dict[str, Any]],
) -> None:
    anchors: set[tuple[str, str, str]] = set()
    accepted_installs = [
        item for item in attempts
        if item["record"]["event_name"] == "install"
        and decision_for(decisions, item)["ingestion_status"] == "accepted"
        and decision_for(decisions, item)["duplicate_resolution"] == "unique"
    ]
    for attempt in accepted_installs:
        server, record = attempt["server"], attempt["record"]
        payload = record["payload"]
        key = evidence_key(server["tenant_id"], server["app_id"], payload["installation_id"])
        if key in anchors:
            raise ValueError(f"ambiguous installation anchor: {payload['installation_id']}")
        anchors.add(key)
        if payload["install_type"] in ("reinstall", "redownload"):
            if not payload.get("prior_installation_id") or payload["prior_installation_id"] == payload["installation_id"]:
                raise ValueError(f"invalid reinstall installation anchor: {record['record_id']}")
            prior = evidence_key(server["tenant_id"], server["app_id"], payload["prior_installation_id"])
            if not any(
                candidate["record"]["event_name"] == "install"
                and evidence_key(candidate["server"]["tenant_id"], candidate["server"]["app_id"], candidate["record"]["payload"]["installation_id"]) == prior
                for candidate in accepted_installs
            ):
                raise ValueError(f"missing prior installation anchor: {record['record_id']}")
        elif payload.get("prior_installation_id"):
            raise ValueError(f"first install must not name a prior installation: {record['record_id']}")


def assert_scoped_references(value: dict[str, Any], attempts: list[dict[str, Any]]) -> None:
    def exists(tenant_id: str, app_id: str, record_id: str) -> bool:
        return any(
            attempt["server"]["tenant_id"] == tenant_id
            and attempt["server"]["app_id"] == app_id
            and attempt["record"]["record_id"] == record_id
            for attempt in attempts
        )

    for request in value.get("privacy_requests", []):
        for affected in request.get("affected_records", []):
            target = next((
                attempt for attempt in attempts
                if attempt["server"]["tenant_id"] == request["tenant_id"]
                and attempt["server"]["app_id"] == request["app_id"]
                and attempt["record"]["record_id"] == affected["record_id"]
            ), None)
            if target is None:
                raise ValueError(
                    f"cross-scope or missing privacy reference: {request['privacy_request_id']}/{affected['record_id']}"
                )
            if (
                request.get("requested_via") == "on_device_sdk"
                and target["record"]["payload"].get("installation_id") != request.get("deletion_subject_ref")
            ):
                raise ValueError(
                    f"on-device privacy request targets another installation: {request['privacy_request_id']}/{affected['record_id']}"
                )
    for correction in value.get("correction_inputs", []):
        if not exists(correction["tenant_id"], correction["app_id"], correction["corrects_record_id"]):
            raise ValueError(f"cross-scope or missing correction reference: {correction['correction_id']}")
    for expiration in value.get("retention_expirations", []):
        if not exists(expiration["tenant_id"], expiration["app_id"], expiration["record_id"]):
            raise ValueError(f"cross-scope or missing retention reference: {expiration['record_id']}")
    for attempt in (candidate for candidate in attempts if is_legacy_explicit_refund(candidate)):
        if not exists(
            attempt["server"]["tenant_id"],
            attempt["server"]["app_id"],
            attempt["record"]["payload"]["correction_target_record_id"],
        ):
            raise ValueError(f"cross-scope or missing refund target: {attempt['record']['record_id']}")


def canonical_purchase_original_transaction_id(attempt: dict[str, Any]) -> str | None:
    if attempt["record"]["event_name"] != "purchase":
        return None
    payload = attempt["record"]["payload"]
    return payload.get("original_transaction_id", payload["transaction_id"])


def received_no_later_than(candidate: dict[str, Any], refund: dict[str, Any]) -> bool:
    try:
        return timestamp(candidate["record"]["received_at"], "received_at") <= timestamp(
            refund["record"]["received_at"], "received_at"
        )
    except TimestampInvalidError:
        return False


def occurred_no_later_than(candidate: dict[str, Any], refund: dict[str, Any]) -> bool:
    try:
        return timestamp(candidate["record"]["occurred_at"], "occurred_at") <= timestamp(
            refund["record"]["occurred_at"], "occurred_at"
        )
    except TimestampInvalidError:
        return False


def is_base_accepted_candidate(
    attempt: dict[str, Any], candidates: list[dict[str, Any]],
) -> bool:
    server, record = attempt["server"], attempt["record"]
    try:
        timestamp(record["received_at"], "received_at")
        timestamp(record["occurred_at"], "occurred_at")
        if record["tenant_id"] != server["tenant_id"] or record["app_id"] != server["app_id"]:
            return False
        if sum(1 for other in candidates if other["record"]["record_id"] == record["record_id"]) != 1:
            return False
        if next((other for other in candidates if scope_key(other) == scope_key(attempt)), None) is not attempt:
            return False
        if not consent_decision(attempt)["allowed"]:
            return False
        stale_policy = server.get("timestamp_stale_policy")
        if stale_policy and timestamp(record["occurred_at"], "occurred_at") < timestamp(
            stale_policy["before"], "timestamp_stale_policy.before"
        ):
            return False
        if record.get("subject_scope") == "aggregate" and record["payload"].get("installation_id"):
            return False
        return True
    except (TimestampInvalidError, KeyError, TypeError, ValueError):
        return False


def is_anchored_commerce(attempt: dict[str, Any]) -> bool:
    return (attempt["record"]["event_name"] in {"purchase", "refund"}
            and isinstance(attempt["record"]["payload"].get("installation_id"), str))


def is_legacy_explicit_refund(attempt: dict[str, Any]) -> bool:
    payload = attempt["record"]["payload"]
    return (attempt["record"]["event_name"] == "refund"
            and not isinstance(payload.get("installation_id"), str)
            and isinstance(payload.get("correction_target_record_id"), str))


def legacy_refund_target(
    refund: dict[str, Any], candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not is_legacy_explicit_refund(refund):
        return None
    return next((
        candidate for candidate in candidates
        if candidate["server"]["tenant_id"] == refund["server"]["tenant_id"]
        and candidate["server"]["app_id"] == refund["server"]["app_id"]
        and candidate["record"]["record_id"] == refund["record"]["payload"]["correction_target_record_id"]
    ), None)


def canonical_purchase_business_attempts(
    attempt: dict[str, Any], candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    record = attempt["record"]
    if (record["event_name"] != "purchase" or not is_anchored_commerce(attempt)
            or not isinstance(record["payload"].get("transaction_id"), str)):
        return [attempt]
    return [
        candidate for candidate in candidates
        if candidate["record"]["event_name"] == "purchase"
        and is_anchored_commerce(candidate)
        and candidate["server"]["tenant_id"] == attempt["server"]["tenant_id"]
        and candidate["server"]["app_id"] == attempt["server"]["app_id"]
        and candidate["record"]["tenant_id"] == candidate["server"]["tenant_id"]
        and candidate["record"]["app_id"] == candidate["server"]["app_id"]
        and candidate["record"]["payload"].get("transaction_id") == record["payload"]["transaction_id"]
        and is_base_accepted_candidate(candidate, candidates)
    ]


def canonical_purchase_business_attempt(
    attempt: dict[str, Any], candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    group = canonical_purchase_business_attempts(attempt, candidates)
    return group[0] if group else None


def strict_refund_target_candidates(
    refund: dict[str, Any], candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if refund["record"]["event_name"] != "refund":
        return []
    payload = refund["record"]["payload"]
    if not isinstance(payload.get("installation_id"), str):
        return []
    return [
        candidate for candidate in candidates
        if candidate["record"]["event_name"] == "purchase"
        and candidate["record"]["payload"]["financial_status"] == "settled"
        and candidate["server"]["tenant_id"] == refund["server"]["tenant_id"]
        and candidate["server"]["app_id"] == refund["server"]["app_id"]
        and candidate["record"]["tenant_id"] == candidate["server"]["tenant_id"]
        and candidate["record"]["app_id"] == candidate["server"]["app_id"]
        and candidate["record"]["record_id"] not in refund["server"].get("refund_target_ineligible_record_ids", [])
        and received_no_later_than(candidate, refund)
        and occurred_no_later_than(candidate, refund)
        and candidate["record"]["payload"].get("installation_id") == payload["installation_id"]
        and canonical_purchase_original_transaction_id(candidate) == payload["original_transaction_id"]
        and candidate["record"]["payload"]["currency"] == payload["currency"]
        and is_base_accepted_candidate(candidate, candidates)
        and canonical_purchase_business_attempt(candidate, candidates) is candidate
    ]


def resolve_refund_target_identity(
    refund: dict[str, Any], candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    explicit_target = refund["record"]["payload"].get("correction_target_record_id")
    matches = strict_refund_target_candidates(refund, candidates)
    if len(matches) != 1:
        return None
    if isinstance(explicit_target, str) and matches[0]["record"]["record_id"] != explicit_target:
        return None
    return matches[0]


def exact_money_at_scale(payload: dict[str, Any], scale: int) -> int:
    return int(payload["amount_unscaled"]) * 10 ** (scale - int(payload["amount_scale"]))


def refund_business_key(refund: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        refund["server"]["tenant_id"], refund["server"]["app_id"],
        refund["record"]["event_name"], refund["record"]["payload"]["transaction_id"],
    )


def admitted_refunds(
    candidates: list[dict[str, Any]],
) -> tuple[dict[tuple[str, ...], dict[str, Any]], dict[tuple[str, str, str, str], dict[str, Any]]]:
    targets: dict[tuple[str, ...], dict[str, Any]] = {}
    winners: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    settled_by_target: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    ordered = sorted([
        candidate for candidate in candidates
        if candidate["record"]["event_name"] == "refund"
        and is_anchored_commerce(candidate)
        and isinstance(candidate["record"]["payload"].get("transaction_id"), str)
        and is_base_accepted_candidate(candidate, candidates)
    ], key=lambda item: (
        utf16_key(item["record"]["received_at"]), utf16_key(item["record"]["record_id"]),
        utf16_key(item["record"]["delivery_id"]), utf16_key(item["server"]["tenant_id"]),
        utf16_key(item["server"]["app_id"]), utf16_key(item["record"]["schema_version"]),
        utf16_key(digest(item["record"])),
    ))
    for candidate in ordered:
        business_key = refund_business_key(candidate)
        if business_key in winners:
            continue
        target = resolve_refund_target_identity(candidate, candidates)
        if target is None:
            continue
        if candidate["record"]["payload"]["financial_status"] == "settled":
            target_key = attempt_decision_key(target)
            prior = settled_by_target.get(target_key, [])
            scale = max(
                [int(target["record"]["payload"]["amount_scale"]),
                 int(candidate["record"]["payload"]["amount_scale"])]
                + [int(refund["record"]["payload"]["amount_scale"]) for refund in prior]
            )
            refunded = sum(exact_money_at_scale(refund["record"]["payload"], scale) for refund in prior)
            if (refunded + exact_money_at_scale(candidate["record"]["payload"], scale)
                    > exact_money_at_scale(target["record"]["payload"], scale)):
                continue
            settled_by_target[target_key] = [*prior, candidate]
        winners[business_key] = candidate
        targets[attempt_decision_key(candidate)] = target
    return targets, winners


def resolve_refund_target(
    refund: dict[str, Any], candidates: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not is_anchored_commerce(refund):
        return None
    targets, _ = admitted_refunds(candidates)
    return targets.get(attempt_decision_key(refund))


def consent_decision(attempt: dict[str, Any]) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    purpose = next(
        (entry for entry in server.get("processing_purposes", [])
         if entry["processing_purpose_id"] == record.get("processing_purpose_id")),
        None,
    )
    withdrawal = next(
        (entry for entry in server.get("withdrawals", [])
         if entry["processing_purpose_id"] == record.get("processing_purpose_id")),
        None,
    )
    base: dict[str, Any] = {
        "consent_evaluation_policy_version": purpose["policy_version"] if purpose else "not-applicable",
    }
    if record.get("processing_purpose_id"):
        base["processing_purpose_id"] = record["processing_purpose_id"]
    if withdrawal:
        base["withdrawal_recognized_at"] = withdrawal["withdrawal_recognized_at"]
    if (
        not record.get("processing_purpose_id")
        or not purpose
        or not purpose["consent_required"]
        or record["event_name"] in ("consent_changed", "privacy_control")
    ):
        return base | {"allowed": True, "consent_decision_reason_code": "consent_not_required"}
    if not withdrawal or int(record["processing_sequence"]) < int(withdrawal["withdrawal_recognized_sequence"]):
        return base | {"allowed": True, "consent_decision_reason_code": "consent_valid_before_withdrawal"}
    configured = next(
        (
            entry for entry in server.get("alternative_legal_bases", [])
            if entry["alternative_legal_basis_id"] == record.get("alternative_legal_basis_id")
            and entry["processing_purpose_id"] == record.get("processing_purpose_id")
            and timestamp(entry["effective_at"], "effective_at") <= timestamp(record["received_at"], "received_at")
        ),
        None,
    )
    if configured:
        return base | {
            "allowed": True,
            "consent_decision_reason_code": "documented_alternative_legal_basis",
            "alternative_legal_basis_id": configured["alternative_legal_basis_id"],
            "alternative_legal_basis_policy_version": configured["policy_version"],
        }
    return base | {"allowed": False, "consent_decision_reason_code": "consent_withdrawn"}


def timestamp_invalid_decision(attempt: dict[str, Any]) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    purpose = next(
        (entry for entry in server.get("processing_purposes", [])
         if entry["processing_purpose_id"] == record.get("processing_purpose_id")),
        None,
    )
    withdrawal = next(
        (entry for entry in server.get("withdrawals", [])
         if entry["processing_purpose_id"] == record.get("processing_purpose_id")),
        None,
    )
    if (
        not record.get("processing_purpose_id")
        or not purpose
        or not purpose["consent_required"]
        or record["event_name"] in ("consent_changed", "privacy_control")
    ):
        consent_reason = "consent_not_required"
    elif not withdrawal or int(record["processing_sequence"]) < int(withdrawal["withdrawal_recognized_sequence"]):
        consent_reason = "consent_valid_before_withdrawal"
    else:
        consent_reason = "consent_withdrawn"
    result: dict[str, Any] = {
        "record_id": record["record_id"],
        "delivery_id": record["delivery_id"],
        "event_name": record["event_name"],
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "ingestion_status": "rejected",
        "duplicate_resolution": "unique",
        "timeliness": "on_time",
        "clock_skew_suspected": False,
        "payload_disposition": "discarded",
        "consent_evaluation_policy_version": purpose["policy_version"] if purpose else "not-applicable",
        "consent_decision_reason_code": consent_reason,
        "reason_code": "timestamp_invalid",
    }
    if record.get("processing_purpose_id"):
        result["processing_purpose_id"] = record["processing_purpose_id"]
    if withdrawal and withdrawal.get("withdrawal_recognized_at"):
        result["withdrawal_recognized_at"] = withdrawal["withdrawal_recognized_at"]
    return result


def pre_ingestion_decision(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_id": item["record_id"],
        "delivery_id": item["delivery_id"],
        "tenant_id": item["tenant_id"],
        "app_id": item["app_id"],
        "received_at": item["received_at"],
        "ingestion_status": "rejected",
        "duplicate_resolution": "unique",
        "timeliness": "on_time",
        "clock_skew_suspected": False,
        "payload_disposition": "discarded",
        "reason_code": item["reason_code"],
        "processing_purpose_id": item.get("processing_purpose_id"),
        "consent_evaluation_policy_version": item["consent_evaluation_policy_version"],
        "consent_decision_reason_code": item["consent_decision_reason_code"],
    }


def decide(attempt: dict[str, Any], attempts: list[dict[str, Any]]) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    if server.get("timestamp_stale_policy"):
        policy = server["timestamp_stale_policy"]
        expected_digest = digest({
            "before": policy["before"],
            "authority": policy["authority"],
            "policy_version": policy["policy_version"],
        })
        if policy["policy_digest"] != expected_digest:
            raise ValueError("timestamp_stale_policy.policy_digest does not match its canonical policy fields")
    if server.get("click_injection_policy"):
        policy = server["click_injection_policy"]
        expected_digest = digest({
            "threshold_seconds": policy["threshold_seconds"],
            "authority": policy["authority"],
            "policy_version": policy["policy_version"],
        })
        if policy["policy_digest"] != expected_digest:
            raise ValueError("click_injection_policy.policy_digest does not match its canonical policy fields")
    same_record_id = [candidate for candidate in attempts if candidate["record"]["record_id"] == record["record_id"]]
    matches = [candidate for candidate in attempts if scope_key(candidate) == scope_key(attempt)]
    first = matches[0]
    canonical_attempt = first
    if len(same_record_id) > 1:
        duplicate = "record_id_collision"
    elif first is attempt:
        duplicate = "unique"
    elif digest(first["record"]["payload"]) == digest(record["payload"]):
        duplicate = "duplicate_delivery"
    else:
        duplicate = "event_id_conflict"
    if duplicate == "unique" and record["event_name"] == "purchase" and is_anchored_commerce(attempt):
        business = canonical_purchase_business_attempts(attempt, attempts)
        business_first = business[0] if business else attempt
        if business_first is not attempt:
            duplicate = ("duplicate_delivery" if digest(business_first["record"]["payload"]) == digest(record["payload"])
                         else "event_id_conflict")
            canonical_attempt = business_first
    if duplicate == "unique" and record["event_name"] == "refund" and is_anchored_commerce(attempt):
        _, winners = admitted_refunds(attempts)
        business_first = winners.get(refund_business_key(attempt))
        if business_first is not None and attempts.index(business_first) < attempts.index(attempt):
            duplicate = ("duplicate_delivery" if digest(business_first["record"]["payload"]) == digest(record["payload"])
                         else "event_id_conflict")
            canonical_attempt = business_first
    consent = consent_decision(attempt)
    status, reason = "accepted", None
    if record["tenant_id"] != server["tenant_id"] or record["app_id"] != server["app_id"]:
        status, reason = "rejected", "client_scope_mismatch"
    elif duplicate == "record_id_collision":
        status, reason = "rejected", "record_id_collision"
    elif not consent["allowed"]:
        status, reason = "rejected", "consent_withdrawn"
    elif server.get("timestamp_stale_policy") and timestamp(record["occurred_at"], "occurred_at") < timestamp(server["timestamp_stale_policy"]["before"], "timestamp_stale_policy.before"):
        status, reason = "rejected", "timestamp_stale"
    elif record.get("subject_scope") == "aggregate" and record["payload"].get("installation_id"):
        status, reason = "rejected", "aggregate_installation_join_forbidden"
    elif duplicate == "event_id_conflict":
        status, reason = "rejected", "event_id_conflict"
    elif (record["event_name"] == "refund" and duplicate == "unique"
          and ((legacy_refund_target(attempt, attempts) if is_legacy_explicit_refund(attempt)
                else resolve_refund_target(attempt, attempts)) is None)):
        status, reason = "rejected", "refund_target_invalid"
    canonical_record_id = None if duplicate == "record_id_collision" else (
        record["record_id"] if duplicate == "unique" else canonical_attempt["record"]["record_id"]
    )
    result = {
        "record_id": record["record_id"],
        "delivery_id": record["delivery_id"],
        "event_name": record["event_name"],
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "ingestion_status": status,
        "duplicate_resolution": duplicate,
        "timeliness": "late" if record.get("late") else "on_time",
        "clock_skew_suspected": timestamp(record["occurred_at"], "occurred_at") > timestamp(record["received_at"], "received_at") + timedelta(minutes=5),
        "payload_disposition": "discarded" if status == "rejected" and reason != "event_id_conflict" else "protected",
    } | {key: value for key, value in consent.items() if key != "allowed" and value is not None}
    if canonical_record_id:
        result["canonical_record_id"] = canonical_record_id
    if reason:
        result["reason_code"] = reason
    if reason == "timestamp_stale":
        result.update({
            "staleness_policy_version": server["timestamp_stale_policy"]["policy_version"],
            "staleness_policy_digest": server["timestamp_stale_policy"]["policy_digest"],
            "staleness_authority": server["timestamp_stale_policy"]["authority"],
        })
    return result


def lifecycle_index(value: dict[str, Any]) -> dict[tuple[str, str, str], str]:
    result: dict[tuple[str, str, str], str] = {}
    for request in value.get("privacy_requests", []):
        if request["status"] == "completed":
            for affected in request.get("affected_records", []):
                result[evidence_key(request["tenant_id"], request["app_id"], affected["record_id"])] = affected["lifecycle_status"]
    for expiration in value.get("retention_expirations", []):
        result[evidence_key(expiration["tenant_id"], expiration["app_id"], expiration["record_id"])] = "purged"
    return result


def raw_record(attempt: dict[str, Any], lifecycle: str) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    consent = consent_decision(attempt)
    result = {
        "contract_version": CONTRACT_VERSION,
        "record_id": record["record_id"],
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "producer": record["producer"],
        "producer_version": record["producer_version"],
        **({"producer_variant": record["producer_variant"]} if record.get("producer_variant") else {}),
        **({"wrapper_version": record["wrapper_version"]} if record.get("wrapper_version") else {}),
        "event_id": record["event_id"],
        "delivery_id": record["delivery_id"],
        "event_name": record["event_name"],
        "schema_version": record["schema_version"],
        "payload_sha256": digest(record["payload"]),
        "occurred_at": record["occurred_at"],
        "occurred_at_source": record["occurred_at_source"],
        "received_at": record["received_at"],
        "payload_lifecycle_status": lifecycle,
        "raw_payload_ref": f"protected:{record['record_id']}" if lifecycle == "available" else f"tombstone:{record['record_id']}",
        **({"integrity_verdict": record["integrity_verdict"]} if record.get("integrity_verdict") else {}),
        "consent_evaluation_policy_version": consent["consent_evaluation_policy_version"],
        "consent_decision_reason_code": consent["consent_decision_reason_code"],
    }
    for key in (
        "processing_purpose_id", "withdrawal_recognized_at",
        "alternative_legal_basis_id", "alternative_legal_basis_policy_version",
    ):
        if consent.get(key) is not None:
            result[key] = consent[key]
    return result


def attribution(
    attempt: dict[str, Any],
    attempts: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    lifecycle: dict[tuple[str, str, str], str],
) -> dict[str, Any]:
    server, install = attempt["server"], attempt["record"]
    payload = install["payload"]
    attribution_bundle = bound_non_fraud_bundle(server, "attribution-default", ATTRIBUTION_BUNDLE_HASH)

    def evidence(record_id: str) -> dict[str, Any]:
        return {
            "tenant_id": server["tenant_id"],
            "app_id": server["app_id"],
            "ref": record_id,
            "lifecycle_status": lifecycle.get(evidence_key(server["tenant_id"], server["app_id"], record_id), "available"),
            "access_class": "protected",
        }

    base = {
        "attribution_id": f"attr:{install['record_id']}",
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "subject_scope": "installation_level",
        "subject_ref": payload["installation_id"],
        "reason_code_version": CONTRACT_VERSION,
        "evidence_refs": [evidence(install["record_id"])],
        "effective_at": install["occurred_at"],
        "decided_at": server["received_at"],
        "input_cutoff_at": server["received_at"],
        "finality": "final",
        **attribution_bundle,
    }

    def result(status: str, method: str, model: str, reason: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        attribution = base | {"status": status, "method": method, "model": model, "reason_code": reason} | (extra or {})
        if not any(entry["lifecycle_status"] != "available" for entry in attribution["evidence_refs"]):
            return attribution
        return attribution | {
            "attribution_id": f"{base['attribution_id']}:recalculated",
            "finality": "superseded",
            "supersedes_attribution_id": base["attribution_id"],
        }

    imported_producer = install["producer"].startswith("import:")
    imported = payload.get("import_context") if imported_producer else None
    if imported_producer:
        if not imported:
            return result("unattributed", "imported", "provider_reported", "provider_unattributed")
        referenced_clicks = [
            candidate for candidate in attempts
            if imported.get("provider_click_ref")
            and candidate["server"]["tenant_id"] == server["tenant_id"]
            and candidate["server"]["app_id"] == server["app_id"]
            and candidate["record"]["event_name"] == "click"
            and candidate["record"]["producer"] == "redirector"
            and candidate["record"]["payload"].get("remote_click_ref") == imported["provider_click_ref"]
            and decision_for(decisions, candidate)["ingestion_status"] == "accepted"
            and decision_for(decisions, candidate)["duplicate_resolution"] == "unique"
        ]
        imported_evidence = ({
            "evidence_refs": [evidence(referenced_clicks[0]["record"]["record_id"]), evidence(install["record_id"])],
        } if len(referenced_clicks) == 1 else {})
        if imported["provider_attributed"]:
            if imported["provider_attribution_strategy"] == "modeled":
                return result("non_organic", "imported", "provider_reported", "provider_modeled_conversion", imported_evidence)
            if not imported.get("provider_confirmed_at"):
                return result("non_organic", "imported", "provider_reported", "provider_time_authority_unavailable", imported_evidence)
            return result("non_organic", "imported", "provider_reported", "provider_attributed", imported_evidence)
        if imported["provider_attribution_strategy"] == "organic":
            return result("organic", "imported", "provider_reported", "provider_organic")
        return result("unattributed", "imported", "provider_reported", "provider_unattributed")

    if payload.get("meta_referrer_status") == "decrypted":
        return result(
            "non_organic", "meta_install_referrer",
            payload["meta_referrer_context"]["attribution_model"], "meta_referrer_decrypted",
        )
    if payload.get("meta_referrer_status") in ("decrypt_failed", "auth_failed"):
        return result(
            "unattributed", "meta_install_referrer",
            payload.get("meta_referrer_context", {}).get("attribution_model", "last_click"), "meta_referrer_decrypt_failed",
        )
    if payload.get("adservices_context", {}).get("status") == "attributed":
        return result("non_organic", "apple_adservices", "last_click", "adservices_attributed")
    if payload.get("adservices_context", {}).get("status") == "token_expired":
        return result("unattributed", "apple_adservices", "last_click", "adservices_token_expired")
    if payload.get("adservices_context", {}).get("status") == "not_attributed":
        return result("unattributed", "apple_adservices", "last_click", "adservices_not_attributed")
    if payload.get("adservices_context", {}).get("status") == "lookup_unavailable":
        return result("unattributed", "apple_adservices", "last_click", "adservices_lookup_unavailable")

    if payload["referrer_status"] == "none":
        return result("organic", "none", "none", "no_referrer")
    if payload["referrer_status"] == "third_party":
        if payload["third_party_referrer_classification"] == "play_organic_marker":
            return result("organic", "none", "none", "no_first_party_referrer")
        return result("unattributed", "none", "none", "foreign_referrer_unresolved")
    if payload["referrer_status"] == "unsupported":
        return result("unattributed", "none", "none", "install_referrer_unsupported")
    if payload["referrer_status"] == "unavailable":
        return result("unattributed", "none", "none", "install_referrer_unavailable")
    if payload["referrer_status"] == "not_applicable":
        return result("unattributed", "none", "none", "platform_referrer_not_available")
    clicks = [
        candidate for candidate in attempts
        if candidate["server"]["tenant_id"] == server["tenant_id"]
        and candidate["server"]["app_id"] == server["app_id"]
        and candidate["record"]["event_name"] == "click"
        and candidate["record"]["payload"].get("click_id") == payload.get("click_id")
        and decision_for(decisions, candidate)["ingestion_status"] == "accepted"
        and decision_for(decisions, candidate)["duplicate_resolution"] == "unique"
    ]
    if not clicks:
        return result("unattributed", "none", "none", "unknown_click_id")
    if len(clicks) > 1:
        return result("unattributed", "none", "none", "ambiguous_click_id")
    click = clicks[0]
    if click["record"]["payload"].get("bot_prefetch"):
        return result("unattributed", "none", "none", "bot_prefetch", {
            "evidence_refs": [evidence(click["record"]["record_id"]), evidence(install["record_id"])],
        })
    click_status = click["record"]["payload"].get("redirector_time_status", "available")
    install_status = payload.get("install_begin_at_server_status", "available" if payload.get("install_begin_at_server") else "missing")
    if "invalid" in (click_status, install_status):
        return result("unattributed", "none", "none", "authoritative_time_invalid")
    if (
        click_status != "available"
        or install_status != "available"
        or not click["record"]["payload"].get("redirector_click_at")
        or not payload.get("install_begin_at_server")
    ):
        return result("unattributed", "none", "none", "authoritative_time_missing")
    delta = timestamp(payload["install_begin_at_server"], "install_begin_at_server") - timestamp(
        click["record"]["payload"]["redirector_click_at"], "redirector_click_at"
    )
    if delta.total_seconds() < 0 or delta >= timedelta(days=7):
        return result("unattributed", "none", "none", "window_expired")
    return result("non_organic", "install_referrer", "last_click", "valid_install_referrer", {
        "evidence_refs": [evidence(click["record"]["record_id"]), evidence(install["record_id"])],
    })


def aggregate_postback_attribution(
    attempt: dict[str, Any],
    lifecycle: dict[tuple[str, str, str], str],
) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    payload = record["payload"]
    postback_bundle = bound_non_fraud_bundle(server, "apple-postback-default", APPLE_POSTBACK_BUNDLE_HASH)
    method = "skadnetwork" if record["event_name"] == "skan_postback" else "adattributionkit"
    status, reason = "non_organic", "skan_postback_verified"
    if not payload["signature_verified"]:
        status, reason = "unattributed", "skan_signature_invalid"
    elif not payload["did_win"]:
        status, reason = "unattributed", "postback_not_winner"
    elif payload.get("source_identifier") is None:
        status, reason = "unattributed", "crowd_anonymity_suppressed"
    elif payload.get("conversion_value") is None and payload.get("coarse_conversion_value") is None:
        status, reason = "unattributed", "conversion_value_null"
    return {
        "attribution_id": f"attr:{record['record_id']}",
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "subject_scope": "aggregate",
        "subject_ref": f"aggregate:{method}:{record['record_id']}",
        "status": status,
        "method": method,
        "model": "aggregate",
        "reason_code": reason,
        "reason_code_version": CONTRACT_VERSION,
        "evidence_refs": [{
            "tenant_id": server["tenant_id"],
            "app_id": server["app_id"],
            "ref": record["record_id"],
            "lifecycle_status": lifecycle.get(
                evidence_key(server["tenant_id"], server["app_id"], record["record_id"]), "available",
            ),
            "access_class": "protected",
        }],
        "effective_at": record["occurred_at"],
        "decided_at": server["received_at"],
        "input_cutoff_at": server["received_at"],
        "finality": "final",
        **postback_bundle,
    }


def deep_link_attribution(
    attempt: dict[str, Any],
    lifecycle: dict[tuple[str, str, str], str],
) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    resolution = server.get("deep_link_resolution", {"status": "unknown"})
    attribution_bundle = bound_non_fraud_bundle(server, "attribution-default", ATTRIBUTION_BUNDLE_HASH)
    reused = (
        record["payload"]["open_source"] == "android_deferred_referrer"
        and resolution.get("install_attribution_click_id") == record["payload"].get("click_id")
    )
    if reused:
        status, reason = "unattributed", "deep_link_install_click_reused"
    elif resolution["status"] == "active":
        status, reason = "non_organic", "deep_link_open_attributed"
    elif resolution["status"] == "inactive":
        status, reason = "unattributed", "deep_link_link_inactive"
    else:
        status, reason = "unattributed", "deep_link_unknown_link"
    return {
        "attribution_id": f"attr:engagement:{record['record_id']}",
        "tenant_id": server["tenant_id"],
        "app_id": server["app_id"],
        "subject_scope": "engagement_level",
        "subject_ref": f"engagement:{record['record_id']}",
        "status": status,
        "method": "deep_link",
        "model": "last_click",
        "reason_code": reason,
        "reason_code_version": CONTRACT_VERSION,
        "evidence_refs": [{
            "tenant_id": server["tenant_id"],
            "app_id": server["app_id"],
            "ref": record["record_id"],
            "lifecycle_status": lifecycle.get(evidence_key(server["tenant_id"], server["app_id"], record["record_id"]), "available"),
            "access_class": "protected",
        }],
        "effective_at": record["occurred_at"],
        "decided_at": server["received_at"],
        "input_cutoff_at": server["received_at"],
        "finality": "final",
        **attribution_bundle,
    }


def round_half_even(numerator: int, denominator: int) -> int:
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    negative = numerator < 0
    absolute = abs(numerator)
    quotient, remainder = divmod(absolute, denominator)
    twice = remainder * 2
    if twice > denominator or (twice == denominator and quotient % 2 == 1):
        quotient += 1
    return -quotient if negative else quotient


def convert_money(payload: dict[str, Any], policy: dict[str, Any]) -> int:
    rate = next((candidate for candidate in policy["rates"] if candidate["currency"] == payload["currency"]), None)
    if rate is None:
        raise ValueError(f"missing FX rate for {payload['currency']}")
    numerator = int(payload["amount_unscaled"]) * int(rate["rate_unscaled"]) * 10 ** int(policy["target_scale"])
    denominator = 10 ** (int(payload["amount_scale"]) + int(rate["rate_scale"]))
    return round_half_even(numerator, denominator)


def day(value: str, zone: str, field: str) -> str:
    result = timestamp(value, field)
    if zone == "Asia/Tokyo":
        result += timedelta(hours=9)
    return result.date().isoformat()


def base_metric_definitions() -> list[dict[str, Any]]:
    definitions = [
        (
            "d0_install_to_24h_ad_revenue_usd", "UTC",
            {"calculation": "revenue_sum", "window": {"type": "elapsed", "day": 0}, "numerator": "revenue"},
        ),
        (
            "d0_utc_install_calendar_ad_revenue_usd", "UTC",
            {"calculation": "revenue_sum", "window": {"type": "calendar_day", "day": 0}, "numerator": "revenue"},
        ),
        (
            "d0_jst_install_calendar_ad_revenue_usd", "Asia/Tokyo",
            {"calculation": "revenue_sum", "window": {"type": "calendar_day", "day": 0}, "numerator": "revenue"},
        ),
    ]
    return [
        {
            "metric_name": metric_name,
            "aggregation_time_zone": zone,
            "definition": definition,
            "metric_definition_version": REFERENCE_RULE_VERSION,
            "anchor_event": "install",
            "value_type": "money",
            "currency": "USD",
            "amount_scale": 6,
            "rule_bundle_id": "metric-default",
            "rule_bundle_version": REFERENCE_RULE_VERSION,
            "rule_bundle_hash": METRIC_DEFAULT_BUNDLE_HASH,
        }
        for metric_name, zone, definition in definitions
    ]


def metric_definitions(value: dict[str, Any]) -> list[dict[str, Any]]:
    definitions = base_metric_definitions() + value.get("metric_definitions", [])
    names: set[str] = set()
    for definition in definitions:
        if definition["metric_name"] in names:
            raise ValueError(f"duplicate metric definition: {definition['metric_name']}")
        validate_metric_definition_series(definition)
        names.add(definition["metric_name"])
    return sort_by_key(definitions, lambda definition: (
        definition["metric_name"], definition["metric_definition_version"],
    ))


def validate_metric_definition_series(definition: dict[str, Any]) -> None:
    purchase_net_days = {
        "cohort_purchase_net_revenue_d0_usd": 0,
        "cohort_purchase_net_revenue_d1_usd": 1,
        "cohort_purchase_net_revenue_d3_usd": 3,
        "cohort_purchase_net_revenue_d7_usd": 7,
        "cohort_purchase_net_revenue_d30_usd": 30,
        "cohort_purchase_net_revenue_d90_usd": 90,
    }
    total_net_series = {
        "cohort_total_net_revenue_d30_usd": (30, "revenue_sum", "money"),
        "cohort_total_net_revenue_d90_usd": (90, "revenue_sum", "money"),
        "d30_total_net_roas": (30, "revenue_over_cost", "ratio"),
        "d90_total_net_roas": (90, "revenue_over_cost", "ratio"),
        "cohort_total_net_ltv_d30_usd": (30, "revenue_over_cohort", "money"),
        "cohort_total_net_ltv_d90_usd": (90, "revenue_over_cohort", "money"),
    }
    aggregate_names = {
        "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
    }
    aggregate_events = {"skan_postback", "adattributionkit_postback"}
    metric_name = definition["metric_name"]
    event_names = definition.get("event_names", [])
    grouping = definition.get("grouping_dimensions", [])

    def fail() -> None:
        raise ValueError(f"metric_definition_series_mismatch:{metric_name}")

    if definition.get("definition", {}).get("numerator") == "purchase_net_revenue" or metric_name in purchase_net_days:
        expected_day = purchase_net_days.get(metric_name)
        expected_version = "0.4.9" if expected_day in {30, 90} else "0.4.8"
        expected_hash = ("9" if expected_version == "0.4.9" else "8") * 64
        if (expected_day is None
                or definition.get("metric_definition_version") != expected_version
                or definition.get("anchor_event") != "install"
                or definition.get("aggregation_time_zone") != "UTC"
                or definition.get("value_type") != "money"
                or definition.get("currency") != "USD"
                or definition.get("amount_scale") != 6
                or definition.get("rule_bundle_id") != "metric-purchase-net"
                or definition.get("rule_bundle_version") != expected_version
                or definition.get("rule_bundle_hash") != expected_hash
                or definition.get("definition", {}).get("calculation") != "revenue_sum"
                or definition.get("definition", {}).get("numerator") != "purchase_net_revenue"
                or definition.get("definition", {}).get("window", {}).get("type") != "elapsed"
                or definition.get("definition", {}).get("window", {}).get("day") != expected_day):
            fail()
        return

    if definition.get("definition", {}).get("numerator") == "total_net_revenue" or metric_name in total_net_series:
        expected = total_net_series.get(metric_name)
        if expected is None:
            fail()
        expected_day, expected_calculation, expected_value_type = expected
        metric_definition = definition.get("definition", {})
        window = metric_definition.get("window", {})
        if (definition.get("metric_definition_version") != "0.4.9"
                or definition.get("anchor_event") != "install"
                or definition.get("aggregation_time_zone") != "UTC"
                or definition.get("value_type") != expected_value_type
                or (expected_value_type == "money"
                    and (definition.get("currency") != "USD" or definition.get("amount_scale") != 6))
                or (expected_value_type == "ratio" and definition.get("ratio_scale") != 6)
                or definition.get("rule_bundle_id") != "metric-total-net"
                or definition.get("rule_bundle_version") != "0.4.9"
                or definition.get("rule_bundle_hash") != "9" * 64
                or metric_definition.get("calculation") != expected_calculation
                or metric_definition.get("numerator") != "total_net_revenue"
                or window.get("type") != "elapsed"
                or window.get("day") != expected_day
                or (expected_calculation == "revenue_over_cost"
                    and (metric_definition.get("denominator") != "cost"
                         or metric_definition.get("cost_basis") != "cohort_acquisition_day_current_snapshot"))
                or (expected_calculation == "revenue_over_cohort"
                    and metric_definition.get("denominator") != "cohort_size")):
            fail()
        return

    if metric_name in aggregate_names:
        expected_event = "adattributionkit_postback" if metric_name == "aak_attributed_installs" else "skan_postback"
        expected_grouping = (
            ["metric_date", "apple_conversion_bucket"]
            if metric_name == "skan_conversion_value_distribution" else ["metric_date"]
        )
        if (definition.get("definition", {}).get("calculation") != "event_count"
                or definition.get("definition", {}).get("numerator") != "events"
                or definition.get("aggregation_time_zone") != "UTC"
                or event_names != [expected_event]
                or sorted(grouping) != sorted(expected_grouping)):
            fail()
        return
    if metric_name in {"daily_deep_link_opens", "daily_deep_link_opens_by_status"}:
        expected_grouping = (
            ["metric_date", "campaign_id", "attribution_status"]
            if metric_name == "daily_deep_link_opens_by_status"
            else ["metric_date", "campaign_id"]
        )
        if (definition.get("definition", {}).get("calculation") != "event_count"
                or definition.get("definition", {}).get("numerator") != "events"
                or event_names != ["deep_link_open"]
                or sorted(grouping) != sorted(expected_grouping)):
            fail()
        return
    if any(event_name in aggregate_events for event_name in event_names) or "apple_conversion_bucket" in grouping:
        fail()


def cost_records(value: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for record in value.get("cost_records", []):
        dimensions = {
            field: record[field]
            for field in ("network", "campaign_id", "ad_group_id", "country")
            if field in record
        }
        if record["dimension_digest"] != digest(dimensions):
            raise ValueError(f"cost dimension_digest mismatch: {record['cost_record_id']}")
        records.append(record | {"contract_version": CONTRACT_VERSION})
    return sort_by_key(records, lambda record: (
        record["cost_record_id"], record["tenant_id"], record["app_id"], record["as_of"],
    ))


def scale_money(payload: dict[str, Any], target_scale: int) -> int:
    difference = target_scale - int(payload["amount_scale"])
    if difference >= 0:
        return int(payload["amount_unscaled"]) * 10 ** difference
    return round_half_even(int(payload["amount_unscaled"]), 10 ** -difference)


def matches_grouping(
    attempt: dict[str, Any],
    grouping: dict[str, Any] | None,
    attribution_statuses: dict[tuple[str, str, str], str],
) -> bool:
    if not grouping:
        return True
    payload = attempt["record"]["payload"]
    context = payload.get("import_context", {})
    campaign = payload.get("campaign_id", attempt["server"].get("deep_link_resolution", {}).get("campaign_id", context.get("provider_campaign_ref")))
    network = payload.get("network", payload.get("ad_network", context.get("provider_network")))
    if grouping.get("campaign_id") is not None and campaign != grouping["campaign_id"]:
        return False
    if grouping.get("network") is not None and network != grouping["network"]:
        return False
    if grouping.get("country") is not None and payload.get("country", context.get("provider_country")) != grouping["country"]:
        return False
    if grouping.get("cohort_date") is not None and attempt["record"]["event_name"] == "install" and day(attempt["record"]["occurred_at"], "UTC", "occurred_at") != grouping["cohort_date"]:
        return False
    if grouping.get("attribution_status") is not None and attempt["record"]["event_name"] in ("install", "deep_link_open"):
        subject_ref = (
            attempt["record"]["payload"]["installation_id"]
            if attempt["record"]["event_name"] == "install"
            else f"engagement:{attempt['record']['record_id']}"
        )
        status = attribution_statuses.get((
            attempt["server"]["tenant_id"],
            attempt["server"]["app_id"],
            subject_ref,
        ))
        if status != grouping["attribution_status"]:
            return False
    return True


def eligible_revenue(definition: dict[str, Any], install: dict[str, Any], revenue: dict[str, Any]) -> bool:
    day_index = int(definition["definition"]["window"]["day"])
    if definition["definition"]["window"]["type"] == "calendar_day":
        anchor = timestamp(install["occurred_at"], "occurred_at") + timedelta(days=day_index)
        return day(revenue["occurred_at"], definition["aggregation_time_zone"], "occurred_at") == day(anchor.isoformat(timespec="milliseconds").replace("+00:00", "Z"), definition["aggregation_time_zone"], "occurred_at")
    elapsed = timestamp(revenue["occurred_at"], "occurred_at") - timestamp(install["occurred_at"], "occurred_at")
    return timedelta(0) <= elapsed < timedelta(days=day_index + 1)


def metric_runs(
    value: dict[str, Any],
    attempts: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    lifecycle: dict[tuple[str, str, str], str],
    attributions: list[dict[str, Any]],
    excluded_installation_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    excluded_installation_ids = excluded_installation_ids or set()
    policy = value["fx_policy"]
    definitions = metric_definitions(value)
    definitions_by_name = {definition["metric_name"]: definition for definition in definitions}
    costs = cost_records(value)
    attribution_statuses = {
        (item["tenant_id"], item["app_id"], item["subject_ref"]): item["status"]
        for item in attributions if item["subject_scope"] in ("installation_level", "engagement_level")
    }
    output: list[dict[str, Any]] = []
    for evaluation in value.get("metric_evaluations", []):
        included = [
            attempt for attempt in attempts
            if decision_for(decisions, attempt)["ingestion_status"] == "accepted"
            and decision_for(decisions, attempt)["duplicate_resolution"] == "unique"
            and attempt["record"]["received_at"] <= evaluation["input_received_at_watermark"]
        ]
        included.sort(key=lambda attempt: (
            utf16_key(attempt["record"]["received_at"]),
            utf16_key(attempt["record"]["record_id"]),
            utf16_key(attempt["record"]["delivery_id"]),
        ))
        record_snapshot_rows = [
            [
                attempt["record"]["received_at"],
                attempt["record"]["record_id"],
                lifecycle.get(attempt_evidence_key(attempt), "available") if evaluation["privacy_state"] == "after" else "available",
                attempt["server"]["policy_digest"],
            ]
            for attempt in included
        ]
        visible = [
            attempt for attempt in included
            if evaluation["privacy_state"] != "after" or attempt_evidence_key(attempt) not in lifecycle
        ]
        installs = [
            attempt for attempt in visible
            if attempt["record"]["event_name"] == "install"
            and matches_grouping(attempt, evaluation.get("grouping"), attribution_statuses)
        ]
        revenue = [
            attempt for attempt in visible
            if attempt["record"]["event_name"] == "ad_revenue"
            and attempt["record"]["payload"].get("subject_scope") == "installation_level"
        ]
        purchases = [
            attempt for attempt in visible
            if attempt["record"]["event_name"] == "purchase"
            and attempt["record"]["payload"]["financial_status"] == "settled"
        ]
        refunds = [
            attempt for attempt in visible
            if attempt["record"]["event_name"] == "refund"
            and attempt["record"]["payload"]["financial_status"] == "settled"
        ]
        activities = visible
        states = [
            lifecycle[attempt_evidence_key(attempt)]
            for attempt in included
            if evaluation["privacy_state"] == "after" and attempt_evidence_key(attempt) in lifecycle
        ]
        reproducibility = "redaction_affected" if "redacted" in states else ("retention_affected" if "purged" in states else "fully_reproducible")
        record_evidence = [
            {
                "tenant_id": attempt["server"]["tenant_id"],
                "app_id": attempt["server"]["app_id"],
                "ref": attempt["record"]["record_id"],
                "lifecycle_status": lifecycle.get(attempt_evidence_key(attempt), "available") if evaluation["privacy_state"] == "after" else "available",
                "access_class": "protected",
            }
            for attempt in included
        ]
        cohort_scopes = {
            (install["server"]["tenant_id"], install["server"]["app_id"])
            for install in installs
        }
        grouped_costs = [
            cost for cost in costs
            if cost["as_of"] <= evaluation["input_received_at_watermark"]
            and evaluation.get("grouping", {}).get("attribution_status", "non_organic") == "non_organic"
            and (not cohort_scopes or (cost["tenant_id"], cost["app_id"]) in cohort_scopes)
            if all(evaluation.get("grouping", {}).get(field) is None or cost.get(field) == evaluation["grouping"][field] for field in ("campaign_id", "network", "country"))
            and (evaluation.get("grouping", {}).get("cohort_date") is None or cost["date"] == evaluation["grouping"]["cohort_date"])
        ]
        current_by_digest: dict[tuple[str, str, str], dict[str, Any]] = {}
        for cost in sorted(grouped_costs, key=lambda item: (utf16_key(item["as_of"]), utf16_key(item["cost_record_id"]))):
            current_by_digest[(cost["tenant_id"], cost["app_id"], cost["dimension_digest"])] = cost
        current_costs = list(current_by_digest.values())
        cost_snapshot_rows = [
            ["cost", cost["as_of"], cost["cost_record_id"], cost["report_snapshot_digest"], cost["dimension_digest"]]
            for cost in sort_by_key(current_costs, lambda item: (item["as_of"], item["cost_record_id"]))
        ]
        snapshot_rows = record_snapshot_rows + cost_snapshot_rows
        cost_evidence = [
            {
                "tenant_id": cost["tenant_id"], "app_id": cost["app_id"], "ref": cost["cost_record_id"],
                "lifecycle_status": "available", "access_class": "protected",
            }
            for cost in current_costs
        ]
        evidence = sort_by_key(record_evidence + cost_evidence, lambda item: (item["ref"], item["tenant_id"], item["app_id"]))
        ledger = record_snapshot_rows[-1] if record_snapshot_rows else None
        if len(policy["rates"]) != 1:
            raise ValueError("v0.2 metric runs require exactly one structured FX rate")
        only_rate = policy["rates"][0]
        selected_names = evaluation.get("metric_names", [
            "d0_install_to_24h_ad_revenue_usd",
            "d0_utc_install_calendar_ad_revenue_usd",
            "d0_jst_install_calendar_ad_revenue_usd",
        ])
        for metric_name in selected_names:
            if metric_name not in definitions_by_name:
                raise ValueError(f"unknown metric definition: {metric_name}")
            definition = definitions_by_name[metric_name]
            eligible_installs = [
                item for item in installs
                if definition.get("fraud_policy") != "net"
                or item["record"]["payload"]["installation_id"] not in excluded_installation_ids
            ]
            unsupported = [
                dimension for dimension in evaluation.get("grouping", {})
                if definition.get("grouping_dimensions") is not None
                and dimension not in definition["grouping_dimensions"]
            ]
            if unsupported:
                raise ValueError(f"unsupported grouping for {metric_name}: {','.join(unsupported)}")
            revenue_value = 0
            for item in revenue:
                installation = next(
                    (
                        candidate for candidate in eligible_installs
                        if candidate["server"]["tenant_id"] == item["server"]["tenant_id"]
                        and candidate["server"]["app_id"] == item["server"]["app_id"]
                        and candidate["record"]["payload"]["installation_id"] == item["record"]["payload"]["installation_id"]
                    ),
                    None,
                )
                if installation and eligible_revenue(definition, installation["record"], item["record"]):
                    revenue_value += convert_money(item["record"]["payload"], policy)
            purchase_net_revenue_value = 0
            if definition["definition"]["numerator"] in {"purchase_net_revenue", "total_net_revenue"}:
                for item in purchases:
                    installation = next((
                        candidate for candidate in eligible_installs
                        if candidate["server"]["tenant_id"] == item["server"]["tenant_id"]
                        and candidate["server"]["app_id"] == item["server"]["app_id"]
                        and candidate["record"]["payload"]["installation_id"] == item["record"]["payload"].get("installation_id")
                    ), None)
                    if installation and eligible_revenue(definition, installation["record"], item["record"]):
                        purchase_net_revenue_value += convert_money(item["record"]["payload"], policy)
                for item in refunds:
                    target = resolve_refund_target(item, visible)
                    if target is None or target["record"]["payload"]["financial_status"] != "settled":
                        continue
                    installation = next((
                        candidate for candidate in eligible_installs
                        if candidate["server"]["tenant_id"] == target["server"]["tenant_id"]
                        and candidate["server"]["app_id"] == target["server"]["app_id"]
                        and candidate["record"]["payload"]["installation_id"] == target["record"]["payload"].get("installation_id")
                    ), None)
                    if installation and eligible_revenue(definition, installation["record"], item["record"]):
                        purchase_net_revenue_value -= convert_money(item["record"]["payload"], policy)
            selected_revenue_value = (
                purchase_net_revenue_value
                if definition["definition"]["numerator"] == "purchase_net_revenue"
                else revenue_value + purchase_net_revenue_value
                if definition["definition"]["numerator"] == "total_net_revenue"
                else revenue_value
            )
            cohort_ids = {install["record"]["payload"]["installation_id"] for install in eligible_installs}
            cohort_size = len(cohort_ids)
            calculation = definition["definition"]["calculation"]
            amount: int | None = None
            undefined_reason: str | None = None
            if calculation == "revenue_sum":
                amount = selected_revenue_value
            elif calculation == "revenue_over_cost":
                cost_value = 0
                for cost in current_costs:
                    if cost["currency"] != policy["target_currency"]:
                        raise ValueError(f"cost currency mismatch: {cost['cost_record_id']}")
                    cost_value += scale_money(cost, int(policy["target_scale"]))
                if cost_value == 0:
                    undefined_reason = "no_attributed_cost"
                else:
                    amount = round_half_even(selected_revenue_value * 10 ** int(definition.get("ratio_scale", 6)), cost_value)
            elif calculation == "active_installations_over_cohort":
                if cohort_size == 0:
                    undefined_reason = "empty_cohort"
                else:
                    event_names = set(definition.get("activity_events", ["session_start"]))
                    active: set[str] = set()
                    for activity in (item for item in activities if item["record"]["event_name"] in event_names):
                        installation = next((candidate for candidate in eligible_installs
                                             if candidate["server"]["tenant_id"] == activity["server"]["tenant_id"]
                                             and candidate["server"]["app_id"] == activity["server"]["app_id"]
                                             and candidate["record"]["payload"]["installation_id"] == activity["record"]["payload"].get("installation_id")), None)
                        if installation is None:
                            continue
                        day_index = (timestamp(activity["record"]["occurred_at"], "occurred_at") - timestamp(installation["record"]["occurred_at"], "occurred_at")).days
                        if day_index == definition["definition"]["window"]["day"]:
                            active.add(installation["record"]["payload"]["installation_id"])
                    amount = round_half_even(len(active) * 10 ** int(definition.get("ratio_scale", 6)), cohort_size)
            elif calculation == "revenue_over_cohort":
                if cohort_size == 0:
                    undefined_reason = "empty_cohort"
                else:
                    amount = round_half_even(selected_revenue_value, cohort_size)
            elif calculation == "cohort_size":
                amount = cohort_size
            elif calculation == "event_count":
                event_names = set(definition.get("event_names", []))
                event_name = next(iter(event_names), None)
                metric_date = evaluation.get("grouping", {}).get("metric_date")
                if metric_date is None:
                    raise ValueError(f"event_count requires metric_date grouping: {metric_name}")
                if len(event_names) != 1 or event_name not in {
                    "click", "install", "deep_link_open", "skan_postback", "adattributionkit_postback",
                }:
                    raise ValueError(f"event_count requires exactly one supported event name: {metric_name}")
                aggregate_postback = event_name in {"skan_postback", "adattributionkit_postback"}
                if aggregate_postback:
                    if definition["aggregation_time_zone"] != "UTC":
                        raise ValueError(f"aggregate event_count requires UTC aggregation: {metric_name}")
                    if evaluation.get("grouping", {}).get("attribution_status") is not None:
                        raise ValueError(f"aggregate event_count forbids attribution_status: {metric_name}")
                    expected_event_name = (
                        "adattributionkit_postback" if metric_name == "aak_attributed_installs" else "skan_postback"
                    )
                    if metric_name not in {
                        "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
                    } or event_name != expected_event_name:
                        raise ValueError(f"aggregate event_count metric and event mismatch: {metric_name}")
                    conversion_bucket = evaluation.get("grouping", {}).get("apple_conversion_bucket")
                    if metric_name == "skan_conversion_value_distribution" and conversion_bucket is None:
                        raise ValueError(f"SKAN conversion distribution requires apple_conversion_bucket: {metric_name}")
                    if metric_name != "skan_conversion_value_distribution" and conversion_bucket is not None:
                        raise ValueError(
                            f"apple_conversion_bucket is reserved for SKAN conversion distribution: {metric_name}"
                        )

                    def qualifies_aggregate(item: dict[str, Any]) -> bool:
                        if item["record"]["event_name"] != event_name:
                            return False
                        if day(item["record"]["received_at"], "UTC", "received_at") != metric_date:
                            return False
                        attribution = next((candidate for candidate in attributions
                                            if candidate["tenant_id"] == item["server"]["tenant_id"]
                                            and candidate["app_id"] == item["server"]["app_id"]
                                            and candidate["subject_scope"] == "aggregate"
                                            and candidate["status"] == "non_organic"
                                            and any(reference["ref"] == item["record"]["record_id"]
                                                    for reference in candidate["evidence_refs"])), None)
                        if attribution is None:
                            return False
                        if conversion_bucket is None:
                            return True
                        payload = item["record"]["payload"]
                        actual_bucket = (
                            f"fine:{payload['conversion_value']}" if payload.get("conversion_value") is not None
                            else f"coarse:{payload['coarse_conversion_value']}"
                            if payload.get("coarse_conversion_value") is not None else None
                        )
                        return actual_bucket == conversion_bucket

                    amount = sum(1 for item in visible if qualifies_aggregate(item))
                else:
                    if evaluation.get("grouping", {}).get("apple_conversion_bucket") is not None:
                        raise ValueError(f"apple_conversion_bucket requires aggregate SKAN events: {metric_name}")
                    if evaluation.get("grouping", {}).get("attribution_status") is not None and event_name not in {"install", "deep_link_open"}:
                        raise ValueError(f"attribution_status event_count requires install or deep_link_open events: {metric_name}")
                    amount = sum(
                        1 for item in visible
                        if item["record"]["event_name"] in event_names
                        and (
                            definition.get("fraud_policy") != "net"
                            or item["record"]["event_name"] != "install"
                            or item["record"]["payload"]["installation_id"] not in excluded_installation_ids
                        )
                        and matches_grouping(item, evaluation.get("grouping"), attribution_statuses)
                        and day(item["record"]["occurred_at"], definition["aggregation_time_zone"], "occurred_at") == metric_date
                    )
            else:
                raise ValueError(f"unsupported metric calculation: {calculation}")
            if calculation != "event_count" and evaluation.get("grouping", {}).get("metric_date") is not None:
                raise ValueError(f"metric_date grouping is reserved for event_count: {metric_name}")
            run = {
                "metric_run_id": f"{evaluation['metric_run_id_prefix']}:{metric_name}",
                "metric_name": metric_name,
                "metric_definition_version": definition["metric_definition_version"],
                "input_snapshot_id": digest(snapshot_rows),
                "input_received_at_watermark": evaluation["input_received_at_watermark"],
                "input_ledger_position": f"{ledger[0]}|{ledger[1]}" if ledger else "empty",
                "computed_at": evaluation["computed_at"],
                "data_freshness": evaluation["data_freshness"],
                "aggregation_time_zone": definition["aggregation_time_zone"],
                "rule_bundle_id": definition["rule_bundle_id"],
                "rule_bundle_version": definition["rule_bundle_version"],
                "rule_bundle_hash": definition["rule_bundle_hash"],
                "rounding_mode": policy["rounding_mode"],
                "reproducibility_status": reproducibility,
                "value_type": definition["value_type"],
                "evidence_refs": evidence,
            }
            if definition.get("fraud_policy"):
                run["fraud_policy"] = definition["fraud_policy"]
            if amount is None:
                run |= {"value_state": "undefined", "undefined_reason": undefined_reason}
            else:
                run["value_unscaled"] = str(amount)
            if definition["value_type"] == "money" and amount is not None:
                run |= {
                    "fx_rate_unscaled": only_rate["rate_unscaled"],
                    "fx_rate_scale": only_rate["rate_scale"],
                    "fx_rate_source": only_rate["source"],
                    "fx_rate_as_of": only_rate["as_of"],
                    "fx_rate_snapshot_id": digest(policy["rates"]),
                    "fx_policy_version": policy["policy_version"],
                    "amount_scale": definition["amount_scale"],
                    "currency": definition["currency"],
                }
            if definition["value_type"] == "ratio":
                run["ratio_scale"] = definition["ratio_scale"]
            if evaluation.get("grouping"):
                run["grouping"] = {
                    "dimensions": evaluation["grouping"],
                    "dimension_digest": digest(evaluation["grouping"]),
                }
            if evaluation.get("supersedes_metric_run_id_prefix"):
                run["supersedes_metric_run_id"] = f"{evaluation['supersedes_metric_run_id_prefix']}:{metric_name}"
            output.append(run)
    return sort_by_key(output, metric_run_sort_key)


def imported_reconciliation_inputs(accepted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for attempt in accepted:
        record = attempt["record"]
        if record["event_name"] != "install" or not record["producer"].startswith("import:"):
            continue
        context = record["payload"].get("import_context", {})
        def provider_key(key_type: str, raw_value: str) -> dict[str, Any]:
            return {
                "type": key_type,
                "value": digest({"provider": context["provider"], "type": key_type, "value": raw_value}),
                "scope": "tenant_app",
                "normalization": "identity",
                "cardinality": "one_to_one",
                "protected": True,
                "value_encoding": "sha256",
                "access_class": "protected",
            }

        matching_keys: list[dict[str, Any]] = []
        if context.get("provider_install_ref"):
            matching_keys.append(provider_key("provider_install_id", context["provider_install_ref"]))
        if context.get("provider_click_ref"):
            matching_keys.append(provider_key("provider_click_id", context["provider_click_ref"]))
        item: dict[str, Any] = {
            "reconciliation_id": f"reconciliation:import:{record['record_id']}",
            "tenant_id": attempt["server"]["tenant_id"],
            "app_id": attempt["server"]["app_id"],
            "input_snapshot_id": f"snapshot:internal:{record['record_id']}",
            "external_snapshot_id": f"snapshot:provider:{record['record_id']}",
            "matching_keys": matching_keys,
            "provider_modeled_without_candidate": (
                context.get("provider_attribution_strategy") == "modeled" and not matching_keys
            ),
            "candidates": [],
            "freshness": "current",
        }
        if matching_keys:
            item["candidates"] = [{
                "candidate_id": record["record_id"],
                "tenant_id": attempt["server"]["tenant_id"],
                "app_id": attempt["server"]["app_id"],
                "matching_keys": matching_keys,
                "window_status": "not_applicable",
                "freshness": "current",
                "excluded": False,
            }]
        output.append(item)
    return output


def reconciliation_results(value: dict[str, Any], accepted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    reconciliation_inputs = [*value.get("reconciliation_inputs", []), *imported_reconciliation_inputs(accepted)]
    identities = [(item["tenant_id"], item["app_id"], item["reconciliation_id"]) for item in reconciliation_inputs]
    if len(set(identities)) != len(identities):
        raise ValueError("duplicate reconciliation identity")
    for item in reconciliation_inputs:
        def normalized(entry: dict[str, Any]) -> str:
            if entry["normalization"] == "lowercase_ascii":
                return "".join(character.lower() if "A" <= character <= "Z" else character for character in entry["value"])
            if entry["normalization"] == "trim":
                return entry["value"].strip()
            return entry["value"]

        key = lambda entry: f"{entry['type']}:{entry.get('value_encoding') + ':' if entry.get('value_encoding') else ''}{normalized(entry)}"
        external = {key(entry) for entry in item.get("matching_keys", [])}
        matched = [
            candidate for candidate in item.get("candidates", [])
            if candidate["tenant_id"] == item["tenant_id"]
            and candidate["app_id"] == item["app_id"]
            and any(key(candidate_key) in external for candidate_key in candidate.get("matching_keys", []))
        ]
        if item.get("privacy_effect") == "redaction":
            reason = "redaction_caused_recalculation"
        elif item.get("provider_modeled_without_candidate") and not matched:
            reason = "provider_modeled_conversion"
        elif not external:
            reason = "join_key_missing"
        elif not matched and any(
            entry["type"] in ("provider_click_id", "provider_install_id")
            for entry in item.get("matching_keys", [])
        ):
            reason = "candidate_missing"
        elif not matched:
            reason = "external_row_unmatched"
        elif len(matched) > 1 and any(entry["cardinality"] == "one_to_one" for entry in item["matching_keys"]):
            reason = "join_key_ambiguous"
        elif matched[0]["excluded"]:
            reason = "candidate_excluded"
        elif matched[0]["window_status"] == "out_of_window":
            reason = "window_mismatch"
        elif matched[0]["freshness"] == "stale":
            reason = "freshness_mismatch"
        else:
            reason = "matched"
        matching_keys = sorted(item.get("matching_keys", []), key=lambda entry: utf16_key(key(entry)))
        output.append({
            "reconciliation_id": item["reconciliation_id"],
            "tenant_id": item["tenant_id"],
            "app_id": item["app_id"],
            "input_snapshot_id": item["input_snapshot_id"],
            "external_snapshot_id": item["external_snapshot_id"],
            "difference_reason_code": reason,
            "difference_reason_version": "0.4.0" if reason == "provider_modeled_conversion" else CONTRACT_VERSION,
            "matching_keys": matching_keys,
            "candidates": sorted((candidate["candidate_id"] for candidate in matched), key=utf16_key),
            "exclusions": sorted((candidate["exclusion_reason"] for candidate in matched if candidate["excluded"]), key=utf16_key),
            "windows": sorted((f"{candidate['candidate_id']}:{candidate['window_status']}" for candidate in matched), key=utf16_key),
            "joins": sorted((f"{','.join(key(entry) for entry in matching_keys)}=>{candidate['candidate_id']}" for candidate in matched), key=utf16_key),
            "freshness": matched[0]["freshness"] if matched else item["freshness"],
        })
    return sort_by_key(output, reconciliation_sort_key)


def evaluate(value: dict[str, Any]) -> dict[str, Any]:
    attempts = flatten_attempts(value)
    assert_import_provider_contexts(attempts)
    assert_revenue_anchor_sources(attempts)
    assert_scoped_references(value, attempts)
    decisions_list: list[dict[str, Any]] = []
    for attempt in attempts:
        try:
            decisions_list.append(decide(attempt, attempts))
        except TimestampInvalidError:
            decisions_list.append(timestamp_invalid_decision(attempt))
    decisions = {attempt_decision_key(attempt): decision for attempt, decision in zip(attempts, decisions_list)}
    pre_ingestion_decisions = [pre_ingestion_decision(item) for item in value.get("pre_ingestion_rejections", [])]
    assert_installation_anchors(attempts, decisions)
    lifecycle = lifecycle_index(value)
    accepted = [
        attempt for attempt in attempts
        if decision_for(decisions, attempt)["ingestion_status"] == "accepted"
        and decision_for(decisions, attempt)["duplicate_resolution"] == "unique"
    ]
    conflict_evidence = [
        attempt for attempt in attempts
        if decision_for(decisions, attempt).get("reason_code") == "event_id_conflict"
    ]
    raw_evidence = [
        attempt for attempt in accepted + conflict_evidence
        if attempt_evidence_key(attempt) not in lifecycle
    ]
    logical_evidence = [attempt for attempt in accepted if attempt_evidence_key(attempt) not in lifecycle]
    raw = sort_by_key([raw_record(attempt, "available") for attempt in raw_evidence], raw_record_sort_key)
    deliveries = sort_by_key([
        ({
            "contract_version": CONTRACT_VERSION,
            "delivery_id": attempt["record"]["delivery_id"],
            "record_id": attempt["record"]["record_id"],
            "tenant_id": attempt["server"]["tenant_id"],
            "app_id": attempt["server"]["app_id"],
            "received_at": attempt["record"]["received_at"],
            "ingestion_status": decision_for(decisions, attempt)["ingestion_status"],
            "duplicate_resolution": decision_for(decisions, attempt)["duplicate_resolution"],
            "timeliness": decision_for(decisions, attempt)["timeliness"],
            "clock_skew_suspected": decision_for(decisions, attempt)["clock_skew_suspected"],
            "payload_disposition": decision_for(decisions, attempt)["payload_disposition"],
        } | ({"canonical_record_id": decision_for(decisions, attempt)["canonical_record_id"]}
             if decision_for(decisions, attempt).get("canonical_record_id") else {}))
        | {
            key: decision_for(decisions, attempt)[key]
            for key in (
                "processing_purpose_id", "consent_evaluation_policy_version",
                "consent_decision_reason_code", "withdrawal_recognized_at",
                "alternative_legal_basis_id", "alternative_legal_basis_policy_version",
                "reason_code", "staleness_policy_version", "staleness_policy_digest", "staleness_authority",
            )
            if decision_for(decisions, attempt).get(key) is not None
        }
        for attempt in attempts
    ], delivery_sort_key)
    deliveries = sort_by_key(deliveries + [
        {
            "contract_version": CONTRACT_VERSION,
            "delivery_id": decision["delivery_id"],
            "record_id": decision["record_id"],
            "tenant_id": decision["tenant_id"],
            "app_id": decision["app_id"],
            "received_at": decision["received_at"],
            "ingestion_status": decision["ingestion_status"],
            "duplicate_resolution": decision["duplicate_resolution"],
            "timeliness": decision["timeliness"],
            "clock_skew_suspected": decision["clock_skew_suspected"],
            "payload_disposition": decision["payload_disposition"],
            **({"processing_purpose_id": decision["processing_purpose_id"]}
               if decision.get("processing_purpose_id") else {}),
            "consent_evaluation_policy_version": decision["consent_evaluation_policy_version"],
            "consent_decision_reason_code": decision["consent_decision_reason_code"],
            "reason_code": decision["reason_code"],
        }
        for decision in pre_ingestion_decisions
    ], delivery_sort_key)
    logical = sort_by_key([
        {
            "contract_version": CONTRACT_VERSION,
            "logical_event_id": f"logical:{attempt['server']['tenant_id']}:{attempt['server']['app_id']}:{attempt['record']['producer']}:{attempt['record']['event_id']}",
            "record_id": attempt["record"]["record_id"],
            "tenant_id": attempt["server"]["tenant_id"],
            "app_id": attempt["server"]["app_id"],
            "producer": attempt["record"]["producer"],
            "event_id": attempt["record"]["event_id"],
            "event_name": attempt["record"]["event_name"],
            "record_lifecycle": "active",
            "timeliness": "late" if attempt["record"].get("late") else "on_time",
        }
        for attempt in logical_evidence
    ], logical_event_sort_key)
    attributions = sort_by_key([
        *[
            attribution(attempt, attempts, decisions, lifecycle)
            for attempt in accepted if attempt["record"]["event_name"] == "install"
        ],
        *[
            aggregate_postback_attribution(attempt, lifecycle)
            for attempt in accepted
            if attempt["record"]["event_name"] in ("skan_postback", "adattributionkit_postback")
        ],
        *[
            deep_link_attribution(attempt, lifecycle)
            for attempt in accepted if attempt["record"]["event_name"] == "deep_link_open"
        ],
    ], attribution_sort_key)
    corrections: list[dict[str, Any]] = list(value.get("correction_inputs", []))
    for attempt in accepted:
        if attempt["record"]["event_name"] == "refund":
            legacy = is_legacy_explicit_refund(attempt)
            if not legacy and attempt["record"]["payload"]["financial_status"] != "settled":
                continue
            if legacy:
                corrects_record_id = attempt["record"]["payload"].get("correction_target_record_id")
            else:
                target = resolve_refund_target(attempt, accepted)
                corrects_record_id = target["record"]["record_id"] if target is not None else None
            if not isinstance(corrects_record_id, str):
                continue
            corrections.append({
                "contract_version": CONTRACT_VERSION,
                "tenant_id": attempt["server"]["tenant_id"],
                "app_id": attempt["server"]["app_id"],
                "correction_id": f"correction:{attempt['record']['record_id']}",
                "corrects_record_id": corrects_record_id,
                "correction_type": "correction",
                "correction_reason": "refund",
                "effective_at": attempt["record"]["occurred_at"],
            })
    for request in value.get("privacy_requests", []):
        if request["status"] != "completed":
            continue
        for affected in request.get("affected_records", []):
            corrections.append({
                "contract_version": CONTRACT_VERSION,
                "tenant_id": request["tenant_id"],
                "app_id": request["app_id"],
                "correction_id": f"correction:{request['privacy_request_id']}:{affected['record_id']}",
                "corrects_record_id": affected["record_id"],
                "correction_type": "redaction",
                "correction_reason": request["reason_code"],
                "effective_at": request["completed_at"],
            })
    privacy_requests = sort_by_key(
        [request | {"contract_version": CONTRACT_VERSION} for request in value.get("privacy_requests", [])],
        privacy_request_sort_key,
    )
    tombstones = sort_by_key([
        {
            "contract_version": CONTRACT_VERSION,
            "tenant_id": request["tenant_id"],
            "app_id": request["app_id"],
            "privacy_request_id": request["privacy_request_id"],
            "record_id": affected["record_id"],
            "lifecycle_status": affected["lifecycle_status"],
            "reason_code": request["reason_code"],
            "policy_version": request["policy_version"],
            "provenance_digest": digest([
                request["tenant_id"], request["app_id"], request["privacy_request_id"],
                affected["record_id"], request["completed_at"],
            ]),
            "created_at": request["completed_at"],
        }
        for request in value.get("privacy_requests", [])
        if request["status"] == "completed"
        for affected in request.get("affected_records", [])
    ], privacy_tombstone_sort_key)
    fraud_values: list[dict[str, Any]] = []
    for attempt in accepted:
        payload = attempt["record"]["payload"]
        if attempt["record"]["event_name"] != "click" or not (
            payload.get("bot_prefetch") or payload.get("replay_suspected")
        ):
            continue
        bound = bound_fraud_bundle(attempt["server"])
        if bound is None:
            continue
        bundle, bundle_hash = bound
        reason = "replay_suspected" if payload.get("replay_suspected") else "bot_prefetch"
        rule_id = "transport-replay-v1" if reason == "replay_suspected" else "transport-bot-prefetch-v1"
        action = fraud_action(bundle, rule_id, "exclude")
        fraud_values.append({
            "fraud_decision_id": f"fraud:{attempt['record']['record_id']}",
            "subject_ref": attempt["record"]["record_id"],
            "decision": "suspected",
            "action": action,
            "reason_code": reason,
            "reason_code_version": CONTRACT_VERSION,
            "evidence": [{
                "type": "replay_category" if reason == "replay_suspected" else "link_prefetch_category",
                "captured_at": attempt["record"]["received_at"],
                "digest": digest([reason, attempt["record"]["record_id"]]),
                "access_class": "protected",
            }],
            "rule_bundle_id": bundle["id"],
            "rule_bundle_version": bundle["version"],
            "rule_bundle_hash": bundle_hash,
            "rule_id": rule_id,
            "evaluated_at": attempt["record"]["received_at"],
        } | quarantine_deadline(action, attempt["record"]["received_at"], bundle))
    for attempt in accepted:
        if attempt["record"]["event_name"] != "install":
            continue
        bound = bound_fraud_bundle(attempt["server"])
        if bound is None:
            continue
        bundle, bundle_hash = bound
        payload = attempt["record"]["payload"]
        matching_clicks = [
            candidate for candidate in accepted
            if candidate["server"]["tenant_id"] == attempt["server"]["tenant_id"]
            and candidate["server"]["app_id"] == attempt["server"]["app_id"]
            and candidate["record"]["event_name"] == "click"
            and candidate["record"]["payload"].get("click_id") == payload.get("click_id")
            and candidate["record"]["payload"].get("redirector_time_status") != "invalid"
            and candidate["record"]["payload"].get("redirector_click_at")
        ]
        click = matching_clicks[0] if len(matching_clicks) == 1 else None
        hits: list[tuple[str, str, str, str, str]] = []
        if (
            payload.get("referrer_click_at_server_status") == "available"
            and payload.get("referrer_click_at_server")
            and payload.get("install_begin_at_server")
            and timestamp(payload["referrer_click_at_server"], "referrer_click_at_server")
            >= timestamp(payload["install_begin_at_server"], "install_begin_at_server") + timedelta(seconds=1)
        ):
            hits.append(("referrer-server-order-v1", "confirmed", "referrer_time_inconsistent", "server_clock_order", "flag"))
        if click is not None and payload.get("install_begin_at_server"):
            try:
                delta = timestamp(payload["install_begin_at_server"], "install_begin_at_server") - timestamp(
                    click["record"]["payload"]["redirector_click_at"], "redirector_click_at"
                )
                threshold = attempt["server"].get("click_injection_policy", {}).get(
                    "threshold_seconds", fraud_parameter(bundle, "ctit_lower_bound_seconds", 10)
                )
                if delta.total_seconds() < 0:
                    hits.append(("ctit-clock-anomaly-v1", "clear", "ctit_clock_anomaly", "ctit_clock_diagnostic", "allow"))
                elif delta.total_seconds() < threshold:
                    hits.append(("ctit-lower-bound-v1", "suspected", "click_injection_suspected", "ctit_category", "flag"))
                referrer_click = payload.get("referrer_click_at_server")
                divergence = fraud_parameter(bundle, "referrer_redirector_divergence_seconds", 300)
                if referrer_click and abs((timestamp(referrer_click, "referrer_click_at_server") - timestamp(
                    click["record"]["payload"]["redirector_click_at"], "redirector_click_at"
                )).total_seconds()) > divergence:
                    hits.append(("referrer-redirector-divergence-v1", "suspected", "referrer_time_inconsistent", "server_clock_order", "flag"))
            except ValueError:
                hits = [hit for hit in hits if hit[0] == "referrer-server-order-v1"]
        for rule_id, decision, reason, evidence_type, fallback_action in hits:
            action = fraud_action(bundle, rule_id, fallback_action)
            fraud_values.append({
                "fraud_decision_id": (
                    f"fraud:{attempt['record']['record_id']}:click-injection"
                    if rule_id == "ctit-lower-bound-v1"
                    else f"fraud:{attempt['record']['record_id']}:{rule_id}"
                ),
                "subject_ref": attempt["record"]["record_id"],
                "decision": decision,
                "action": action,
                "reason_code": reason,
                "reason_code_version": CONTRACT_VERSION,
                "evidence": [{
                    "type": evidence_type,
                    "captured_at": attempt["record"]["received_at"],
                    "digest": digest([rule_id, click["record"]["record_id"] if click else "no-redirector-click", attempt["record"]["record_id"]]),
                    "access_class": "protected",
                }],
                "rule_bundle_id": bundle["id"],
                "rule_bundle_version": bundle["version"],
                "rule_bundle_hash": bundle_hash,
                "rule_id": rule_id,
                "evaluated_at": attempt["record"]["received_at"],
            } | quarantine_deadline(action, attempt["record"]["received_at"], bundle))
    for aggregate in value.get("source_day_aggregates", []):
        scope_attempt = next((attempt for attempt in accepted
                              if attempt["server"]["tenant_id"] == aggregate["tenant_id"]
                              and attempt["server"]["app_id"] == aggregate["app_id"]), None)
        bound = bound_fraud_bundle(scope_attempt["server"]) if scope_attempt else (FRAUD_BUNDLE, FRAUD_BUNDLE_HASH)
        if bound is None:
            continue
        bundle, bundle_hash = bound
        p50 = aggregate.get("ctitP50Ms")
        p95 = aggregate.get("ctitP95Ms")
        if (
            aggregate["clicks"] >= fraud_parameter(bundle, "source_day_min_clicks", 1000)
            and aggregate["installs"] / aggregate["clicks"] <= aggregate["medianCvr"] * fraud_parameter(bundle, "source_day_cvr_median_multiplier", 0.2)
            and p50 is not None and p50 >= fraud_parameter(bundle, "source_day_ctit_p50_min_seconds", 86400) * 1000
            and p95 is not None and p95 / p50 <= fraud_parameter(bundle, "source_day_ctit_p95_p50_max_ratio", 3)
        ):
            rule_id = "source-day-click-flooding-v1"
            source_ref = ":".join([
                "source", aggregate["tenant_id"], aggregate["app_id"], aggregate["metric_date"],
                aggregate["campaign_id"], aggregate["network"], aggregate["site_id"],
            ])
            action = fraud_action(bundle, rule_id, "flag")
            fraud_values.append({
                "fraud_decision_id": f"fraud:{aggregate['input_snapshot_id']}",
                "subject_scope": "source",
                "subject_ref": source_ref,
                "decision": "suspected",
                "action": action,
                "reason_code": "click_flooding_suspected",
                "reason_code_version": CONTRACT_VERSION,
                "evidence": [{
                    "type": "source_day_distribution",
                    "captured_at": aggregate["computed_at"],
                    "digest": aggregate["input_snapshot_id"],
                    "access_class": "protected",
                }],
                "rule_bundle_id": bundle["id"],
                "rule_bundle_version": bundle["version"],
                "rule_bundle_hash": bundle_hash,
                "rule_id": rule_id,
                "evaluated_at": aggregate["computed_at"],
            } | quarantine_deadline(action, aggregate["computed_at"], bundle))
    fraud = sort_by_key(fraud_values, fraud_decision_sort_key)
    provisional_clock_attributions: list[dict[str, Any]] = []
    source_days: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for aggregate in value.get("source_day_aggregates", []):
        key = (aggregate["tenant_id"], aggregate["app_id"], aggregate["metric_date"])
        source_days.setdefault(key, []).append(aggregate)
    for aggregates in source_days.values():
        aggregate = aggregates[0]
        scope_attempt = next((attempt for attempt in accepted
                              if attempt["server"]["tenant_id"] == aggregate["tenant_id"]
                              and attempt["server"]["app_id"] == aggregate["app_id"]), None)
        bound = bound_fraud_bundle(scope_attempt["server"]) if scope_attempt else (FRAUD_BUNDLE, FRAUD_BUNDLE_HASH)
        install_count = sum(item.get("installs", 0) for item in aggregates)
        if bound is None or not install_count:
            continue
        bundle, _ = bound
        negative_count = sum(item.get("ctitNegativeCount", 0) for item in aggregates)
        negative_rate = negative_count / install_count
        if negative_rate <= fraud_parameter(bundle, "ctit_negative_rate_threshold", 0.05):
            continue
        daily_snapshot_id = digest(sorted(str(item["input_snapshot_id"]) for item in aggregates))
        computed_at = sorted(str(item["computed_at"]) for item in aggregates)[-1]
        for install in (attempt for attempt in accepted
                        if attempt["server"]["tenant_id"] == aggregate["tenant_id"]
                        and attempt["server"]["app_id"] == aggregate["app_id"]
                        and attempt["record"]["event_name"] == "install"
                        and attempt["record"]["payload"].get("click_id")):
            click = next((attempt for attempt in accepted
                          if attempt["server"]["tenant_id"] == aggregate["tenant_id"]
                          and attempt["server"]["app_id"] == aggregate["app_id"]
                          and attempt["record"]["event_name"] == "click"
                          and attempt["record"]["payload"].get("click_id") == install["record"]["payload"]["click_id"]
                          and str(attempt["record"]["payload"].get("redirector_click_at", ""))[:10] == aggregate["metric_date"]), None)
            if click is None:
                continue
            prior = next((item for item in attributions
                          if item["subject_ref"] == install["record"]["payload"]["installation_id"]
                          and item["reason_code"] == "valid_install_referrer"), None)
            if prior is None:
                continue
            provisional_clock_attributions.append(prior | {
                "attribution_id": f"{prior['attribution_id']}:ctit-clock-provisional:{daily_snapshot_id[:12]}",
                "decided_at": computed_at,
                "input_cutoff_at": computed_at,
                "finality": "provisional",
                "supersedes_attribution_id": prior["attribution_id"],
            })
    excluded_click_ids: dict[str, dict[str, Any]] = {}
    for decision in fraud:
        if decision["action"] != "exclude" or decision.get("subject_scope") == "source":
            continue
        click = next((item for item in accepted
                      if item["record"]["record_id"] == decision["subject_ref"]
                      and item["record"]["event_name"] == "click"), None)
        if click and click["server"].get("fraud_actions_enabled") and click["record"]["payload"].get("click_id"):
            excluded_click_ids[click["record"]["payload"]["click_id"]] = decision
    excluded_installation_ids: set[str] = set()
    fraud_attributions: list[dict[str, Any]] = []
    for install in (item for item in accepted if item["record"]["event_name"] == "install"):
        decision = excluded_click_ids.get(install["record"]["payload"].get("click_id"))
        if decision is None:
            continue
        installation_id = install["record"]["payload"]["installation_id"]
        prior = next((item for item in attributions if item["subject_ref"] == installation_id), None)
        if prior is None:
            continue
        excluded_installation_ids.add(installation_id)
        fraud_attributions.append(prior | {
            "attribution_id": f"{prior['attribution_id']}:fraud",
            "status": "unattributed",
            "method": "none",
            "model": "none",
            "reason_code": "fraud_excluded",
            "finality": "final",
            "fraud_decision_ref": decision["fraud_decision_id"],
            "supersedes_attribution_id": prior["attribution_id"],
        })
    attributions = sort_by_key(attributions + provisional_clock_attributions + fraud_attributions, attribution_sort_key)
    rejections = sort_by_key([
        {
            "contract_version": CONTRACT_VERSION,
            "delivery_id": decision["delivery_id"],
            "record_id": decision["record_id"],
            "tenant_id": decision["tenant_id"],
            "app_id": decision["app_id"],
            "reason_code": decision["reason_code"],
            "reason_code_version": CONTRACT_VERSION,
            "payload_disposition": decision["payload_disposition"],
            "retained": "protected_conflict_evidence" if decision["reason_code"] == "event_id_conflict" else "non_identifying_metadata",
            "consent_evaluation_policy_version": decision["consent_evaluation_policy_version"],
            "consent_decision_reason_code": decision["consent_decision_reason_code"],
        }
        | {
            key: decision[key]
            for key in (
                "processing_purpose_id", "withdrawal_recognized_at",
                "staleness_policy_version", "staleness_policy_digest", "staleness_authority",
            )
            if decision.get(key) is not None
        }
        for decision in decisions_list + pre_ingestion_decisions if decision["ingestion_status"] == "rejected"
    ], rejection_sort_key)
    return {
        "raw_records": raw,
        "deliveries": deliveries,
        "logical_events": logical,
        "corrections": sort_by_key(corrections, correction_sort_key),
        "privacy_requests": privacy_requests,
        "privacy_tombstones": tombstones,
        "attributions": attributions,
        "cost_records": cost_records(value),
        "metric_definitions": metric_definitions(value),
        "metric_runs": metric_runs(value, attempts, decisions, lifecycle, attributions, excluded_installation_ids),
        "fraud_decisions": fraud,
        "rejections": rejections,
        "reconciliation": reconciliation_results(value, accepted),
    }


def conformance() -> None:
    vector = {
        "numbers": [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0.0],
        "string": "\u20ac$\u000f\nA'B\"\\\"/",
    }
    print(canonical(vector))


def batch() -> None:
    requests = json.load(sys.stdin)
    if not isinstance(requests, list):
        raise ValueError("batch input must be a JSON array")
    results: list[dict[str, Any]] = []
    for value in requests:
        try:
            results.append({"ok": True, "output": evaluate(value)})
        except TimestampInvalidError as error:
            results.append({
                "ok": False,
                "error": {
                    "name": "TimestampInvalidError",
                    "message": str(error),
                    "exit_code": error.exit_code,
                },
            })
        except Exception as error:
            results.append({
                "ok": False,
                "error": {
                    "name": type(error).__name__,
                    "message": str(error),
                    "exit_code": 1,
                },
            })
    print(canonical(results))


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "--conformance":
            conformance()
        elif len(sys.argv) == 2 and sys.argv[1] == "--batch":
            batch()
        else:
            if sys.argv[1] == "-":
                print(canonical(evaluate(json.load(sys.stdin))))
            else:
                with open(sys.argv[1], encoding="utf-8") as source:
                    print(canonical(evaluate(json.load(source))))
    except TimestampInvalidError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
