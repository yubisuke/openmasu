#!/usr/bin/env python3
"""Independent Python evaluator for Open MMP Contract v0.1 fixtures."""

from __future__ import annotations

import hashlib
import json
import sys
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import rfc8785

CONTRACT_VERSION = "0.1.0"
ZERO_HASH = "0" * 64
DAY_MS = 86_400_000


def canonical(value: Any) -> str:
    return rfc8785.dumps(value).decode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


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
        for record in value["records"]:
            result.append({"server": value["server_context"], "record": record, "batch_id": "batch-default"})
    return sorted(result, key=lambda item: (
        utf16_key(item["record"]["received_at"]), utf16_key(item["record"]["record_id"]),
        utf16_key(item["record"]["delivery_id"]), utf16_key(item["server"]["tenant_id"]),
        utf16_key(item["server"]["app_id"]), utf16_key(item["record"]["schema_version"]),
        utf16_key(digest(item["record"])),
    ))


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
            if not exists(request["tenant_id"], request["app_id"], affected["record_id"]):
                raise ValueError(
                    f"cross-scope or missing privacy reference: {request['privacy_request_id']}/{affected['record_id']}"
                )
    for correction in value.get("correction_inputs", []):
        if not exists(correction["tenant_id"], correction["app_id"], correction["corrects_record_id"]):
            raise ValueError(f"cross-scope or missing correction reference: {correction['correction_id']}")
    for attempt in (item for item in attempts if item["record"]["event_name"] == "refund"):
        target = attempt["record"]["payload"]["correction_target_record_id"]
        if not exists(attempt["server"]["tenant_id"], attempt["server"]["app_id"], target):
            raise ValueError(f"cross-scope or missing refund target: {attempt['record']['record_id']}")


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


def decide(attempt: dict[str, Any], attempts: list[dict[str, Any]]) -> dict[str, Any]:
    server, record = attempt["server"], attempt["record"]
    same_record_id = [candidate for candidate in attempts if candidate["record"]["record_id"] == record["record_id"]]
    matches = [candidate for candidate in attempts if scope_key(candidate) == scope_key(attempt)]
    first = matches[0]
    if len(same_record_id) > 1:
        duplicate = "record_id_collision"
    elif first is attempt:
        duplicate = "unique"
    elif digest(first["record"]["payload"]) == digest(record["payload"]):
        duplicate = "duplicate_delivery"
    else:
        duplicate = "event_id_conflict"
    consent = consent_decision(attempt)
    status, reason = "accepted", None
    if record["tenant_id"] != server["tenant_id"] or record["app_id"] != server["app_id"]:
        status, reason = "rejected", "client_scope_mismatch"
    elif duplicate == "record_id_collision":
        status, reason = "rejected", "record_id_collision"
    elif not consent["allowed"]:
        status, reason = "rejected", "consent_withdrawn"
    elif record.get("subject_scope") == "aggregate" and record["payload"].get("installation_id"):
        status, reason = "rejected", "aggregate_installation_join_forbidden"
    elif duplicate == "event_id_conflict":
        status, reason = "rejected", "event_id_conflict"
    result = {
        "record_id": record["record_id"],
        "canonical_record_id": record["record_id"] if duplicate in ("unique", "record_id_collision") else first["record"]["record_id"],
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
    if reason:
        result["reason_code"] = reason
    return result


def lifecycle_index(value: dict[str, Any]) -> dict[tuple[str, str, str], str]:
    result: dict[tuple[str, str, str], str] = {}
    for request in value.get("privacy_requests", []):
        if request["status"] == "completed":
            for affected in request.get("affected_records", []):
                result[evidence_key(request["tenant_id"], request["app_id"], affected["record_id"])] = affected["lifecycle_status"]
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
        "rule_bundle_id": "attribution-default",
        "rule_bundle_version": CONTRACT_VERSION,
        "rule_bundle_hash": ZERO_HASH,
    }

    def result(status: str, method: str, model: str, reason: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        return base | {"status": status, "method": method, "model": model, "reason_code": reason} | (extra or {})

    if payload["referrer_status"] == "none":
        return result("organic", "none", "none", "no_referrer")
    if payload["referrer_status"] == "unsupported":
        return result("unattributed", "none", "none", "install_referrer_unsupported")
    if payload["referrer_status"] == "unavailable":
        return result("unattributed", "none", "none", "install_referrer_unavailable")
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


def metric_runs(
    value: dict[str, Any],
    attempts: list[dict[str, Any]],
    decisions: dict[str, dict[str, Any]],
    lifecycle: dict[tuple[str, str, str], str],
) -> list[dict[str, Any]]:
    policy = value["fx_policy"]
    definitions = [
        (
            "d0_install_to_24h_ad_revenue_usd",
            "UTC",
            lambda install, revenue: timestamp(install["occurred_at"], "occurred_at") <= timestamp(revenue["occurred_at"], "occurred_at") < timestamp(install["occurred_at"], "occurred_at") + timedelta(days=1),
        ),
        (
            "d0_utc_install_calendar_ad_revenue_usd",
            "UTC",
            lambda install, revenue: day(install["occurred_at"], "UTC", "occurred_at") == day(revenue["occurred_at"], "UTC", "occurred_at"),
        ),
        (
            "d0_jst_install_calendar_ad_revenue_usd",
            "Asia/Tokyo",
            lambda install, revenue: day(install["occurred_at"], "Asia/Tokyo", "occurred_at") == day(revenue["occurred_at"], "Asia/Tokyo", "occurred_at"),
        ),
    ]
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
        snapshot_rows = [
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
        installs = [attempt for attempt in visible if attempt["record"]["event_name"] == "install"]
        revenue = [attempt for attempt in visible if attempt["record"]["event_name"] == "ad_revenue"]
        states = [
            lifecycle[attempt_evidence_key(attempt)]
            for attempt in included
            if evaluation["privacy_state"] == "after" and attempt_evidence_key(attempt) in lifecycle
        ]
        reproducibility = "redaction_affected" if "redacted" in states else ("retention_affected" if "purged" in states else "fully_reproducible")
        evidence = [
            {
                "tenant_id": attempt["server"]["tenant_id"],
                "app_id": attempt["server"]["app_id"],
                "ref": attempt["record"]["record_id"],
                "lifecycle_status": lifecycle.get(attempt_evidence_key(attempt), "available") if evaluation["privacy_state"] == "after" else "available",
                "access_class": "protected",
            }
            for attempt in included
        ]
        ledger = snapshot_rows[-1] if snapshot_rows else None
        only_rate = policy["rates"][0] if len(policy["rates"]) == 1 else None
        for metric_name, zone, eligible in definitions:
            amount = 0
            for item in revenue:
                installation = next(
                    (
                        candidate for candidate in installs
                        if candidate["server"]["tenant_id"] == item["server"]["tenant_id"]
                        and candidate["server"]["app_id"] == item["server"]["app_id"]
                        and candidate["record"]["payload"]["installation_id"] == item["record"]["payload"]["installation_id"]
                    ),
                    None,
                )
                if installation and eligible(installation["record"], item["record"]):
                    amount += convert_money(item["record"]["payload"], policy)
            run = {
                "metric_run_id": f"{evaluation['metric_run_id_prefix']}:{metric_name}",
                "metric_name": metric_name,
                "metric_definition_version": CONTRACT_VERSION,
                "input_snapshot_id": digest(snapshot_rows),
                "input_received_at_watermark": evaluation["input_received_at_watermark"],
                "input_ledger_position": f"{ledger[0]}|{ledger[1]}" if ledger else "empty",
                "computed_at": evaluation["computed_at"],
                "data_freshness": evaluation["data_freshness"],
                "aggregation_time_zone": zone,
                "rule_bundle_id": "metric-default",
                "rule_bundle_version": CONTRACT_VERSION,
                "rule_bundle_hash": ZERO_HASH,
                "fx_rate": f"{only_rate['rate_unscaled']}e-{only_rate['rate_scale']}" if only_rate else "snapshot",
                "fx_rate_source": only_rate["source"] if only_rate else "fixture-rate-snapshot",
                "fx_rate_as_of": only_rate["as_of"] if only_rate else evaluation["computed_at"],
                "fx_rate_snapshot_id": digest(policy["rates"]),
                "fx_policy_version": policy["policy_version"],
                "rounding_mode": policy["rounding_mode"],
                "reproducibility_status": reproducibility,
                "value_unscaled": str(amount),
                "amount_scale": policy["target_scale"],
                "currency": policy["target_currency"],
                "evidence_refs": evidence,
            }
            if evaluation.get("supersedes_metric_run_id_prefix"):
                run["supersedes_metric_run_id"] = f"{evaluation['supersedes_metric_run_id_prefix']}:{metric_name}"
            output.append(run)
    return sort_by_key(output, metric_run_sort_key)


def reconciliation_results(value: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in value.get("reconciliation_inputs", []):
        def normalized(entry: dict[str, Any]) -> str:
            if entry["normalization"] == "lowercase_ascii":
                return "".join(character.lower() if "A" <= character <= "Z" else character for character in entry["value"])
            if entry["normalization"] == "trim":
                return entry["value"].strip()
            return entry["value"]

        key = lambda entry: f"{entry['type']}:{normalized(entry)}"
        external = {key(entry) for entry in item.get("matching_keys", [])}
        matched = [
            candidate for candidate in item.get("candidates", [])
            if candidate["tenant_id"] == item["tenant_id"]
            and candidate["app_id"] == item["app_id"]
            and any(key(candidate_key) in external for candidate_key in candidate.get("matching_keys", []))
        ]
        if item.get("privacy_effect") == "redaction":
            reason = "redaction_caused_recalculation"
        elif not external:
            reason = "join_key_missing"
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
            "difference_reason_version": CONTRACT_VERSION,
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
    assert_scoped_references(value, attempts)
    decisions_list = [decide(attempt, attempts) for attempt in attempts]
    decisions = {attempt_decision_key(attempt): decision for attempt, decision in zip(attempts, decisions_list)}
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
        {
            "contract_version": CONTRACT_VERSION,
            "delivery_id": attempt["record"]["delivery_id"],
            "record_id": attempt["record"]["record_id"],
            "canonical_record_id": decision_for(decisions, attempt)["canonical_record_id"],
            "tenant_id": attempt["server"]["tenant_id"],
            "app_id": attempt["server"]["app_id"],
            "received_at": attempt["record"]["received_at"],
            "ingestion_status": decision_for(decisions, attempt)["ingestion_status"],
            "duplicate_resolution": decision_for(decisions, attempt)["duplicate_resolution"],
            "timeliness": decision_for(decisions, attempt)["timeliness"],
            "clock_skew_suspected": decision_for(decisions, attempt)["clock_skew_suspected"],
            "payload_disposition": decision_for(decisions, attempt)["payload_disposition"],
        }
        | {
            key: decision_for(decisions, attempt)[key]
            for key in (
                "processing_purpose_id", "consent_evaluation_policy_version",
                "consent_decision_reason_code", "withdrawal_recognized_at",
                "alternative_legal_basis_id", "alternative_legal_basis_policy_version",
                "reason_code",
            )
            if decision_for(decisions, attempt).get(key) is not None
        }
        for attempt in attempts
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
            "lifecycle": "active",
            "timeliness": "late" if attempt["record"].get("late") else "on_time",
        }
        for attempt in logical_evidence
    ], logical_event_sort_key)
    attributions = sort_by_key([
        attribution(attempt, attempts, decisions, lifecycle)
        for attempt in accepted if attempt["record"]["event_name"] == "install"
    ], attribution_sort_key)
    corrections: list[dict[str, Any]] = list(value.get("correction_inputs", []))
    for attempt in accepted:
        if attempt["record"]["event_name"] == "refund":
            corrections.append({
                "contract_version": CONTRACT_VERSION,
                "tenant_id": attempt["server"]["tenant_id"],
                "app_id": attempt["server"]["app_id"],
                "correction_id": f"correction:{attempt['record']['record_id']}",
                "corrects_record_id": attempt["record"]["payload"]["correction_target_record_id"],
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
            "reason_digest": digest(request["reason_code"]),
            "policy_digest": digest(request["policy_version"]),
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
    fraud = sort_by_key([
        {
            "fraud_decision_id": f"fraud:{attempt['record']['record_id']}",
            "subject_ref": attempt["record"]["record_id"],
            "decision": "suspected",
            "action": "exclude",
            "reason_code": "bot_prefetch",
            "reason_code_version": CONTRACT_VERSION,
            "evidence": [{
                "type": "link_prefetch_category",
                "captured_at": attempt["record"]["received_at"],
                "digest": digest(["bot_prefetch", attempt["record"]["record_id"]]),
                "access_class": "protected",
            }],
            "rule_bundle_id": "fraud-public-envelope",
            "rule_bundle_version": CONTRACT_VERSION,
            "rule_bundle_hash": ZERO_HASH,
            "evaluated_at": attempt["record"]["received_at"],
        }
        for attempt in accepted
        if attempt["record"]["event_name"] == "click" and attempt["record"]["payload"].get("bot_prefetch")
    ], fraud_decision_sort_key)
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
            for key in ("processing_purpose_id", "withdrawal_recognized_at")
            if decision.get(key) is not None
        }
        for decision in decisions_list if decision["ingestion_status"] == "rejected"
    ], rejection_sort_key)
    return {
        "raw_records": raw,
        "deliveries": deliveries,
        "logical_events": logical,
        "corrections": sort_by_key(corrections, correction_sort_key),
        "privacy_requests": privacy_requests,
        "privacy_tombstones": tombstones,
        "attributions": attributions,
        "metric_runs": metric_runs(value, attempts, decisions, lifecycle),
        "fraud_decisions": fraud,
        "rejections": rejections,
        "reconciliation": reconciliation_results(value),
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
