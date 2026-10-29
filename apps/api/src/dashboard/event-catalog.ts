import type { EventCatalogPage, EventCatalogQuery } from "../event-catalog.js";
import { escapeHtml as escape } from "./html.js";
import { renderCustomConversionScheduleForm } from "./metric-schedules.js";
import { renderMeasurementSetup } from "./measurement-setup.js";

export function eventCatalogFormRequest(form: URLSearchParams): Record<string, unknown> {
  const allowed = ["csrf_token", "event_key", "expected_revision", "display_name", "meaning", "firing_condition", "lifecycle"];
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)
      || !/^(0|[1-9][0-9]{0,9})$/.test(form.get("expected_revision") ?? "")) throw new Error("event_catalog_revision_invalid");
  return { event_key: form.get("event_key"), expected_revision: Number(form.get("expected_revision")),
    display_name: form.get("display_name"), meaning: form.get("meaning"), firing_condition: form.get("firing_condition"), lifecycle: form.get("lifecycle") };
}

export function renderEventCatalog(appId: string, page: EventCatalogPage, query: EventCatalogQuery, token: string): string {
  const app = `/dashboard/apps/${encodeURIComponent(appId)}`, base = `${app}/event-catalog`;
  const csrf = `<input type="hidden" name="csrf_token" value="${escape(token)}">`;
  const fields = (entry?: EventCatalogPage["data"][number]) => `${csrf}
    <label>Exact event key <input name="event_key" value="${escape(entry?.event_key ?? "")}" pattern="[a-z][a-z0-9_]{0,63}" maxlength="64" required${entry ? " readonly" : ""}></label>
    <input type="hidden" name="expected_revision" value="${entry?.revision ?? 0}">
    <label>Display name <input name="display_name" value="${escape(entry?.display_name ?? "")}" maxlength="120" required></label>
    <label>Meaning <input name="meaning" value="${escape(entry?.meaning ?? "")}" maxlength="1000" required></label>
    <label>Firing condition <input name="firing_condition" value="${escape(entry?.firing_condition ?? "")}" maxlength="1000" required></label>
    <label>Lifecycle <select name="lifecycle">${["planned", "active", "deprecated"].map(state => `<option value="${state}"${state === (entry?.lifecycle ?? "planned") ? " selected" : ""}>${state}</option>`).join("")}</select></label>`;
  const rows = page.data.map(entry => `<tr><th scope="row">${escape(entry.event_key)}</th><td>${escape(entry.display_name)}</td>
    <td>${escape(entry.lifecycle ?? "unmanaged")} · revision ${entry.revision}</td><td>${escape(entry.meaning ?? "Not documented")}</td>
    <td>${escape(entry.firing_condition ?? "Not documented")}</td><td>${entry.observation_state === "not_observed"
      ? "Not observed — count and last receipt unknown" : `${escape(entry.observed_count)} retained events · last received ${escape(entry.last_received_at)}`}</td>
    <td><details><summary>Save a new metadata revision</summary><form method="post" action="${base}">${fields(entry)}<button type="submit">Save revision</button></form></details></td></tr>`).join("");
  const next = page.next_cursor ? `${base}?${new URLSearchParams({ prefix: query.prefix, after: page.next_cursor, limit: String(query.limit) })}` : undefined;
  const selectable = page.data.filter(entry => entry.lifecycle !== "deprecated").map(entry => entry.event_key);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu event catalog</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
    <h1>Event catalog</h1><p><a href="${app}/metric-schedules">Metric schedules</a> · <a href="${app}">App and measurement health</a></p>
    <p>Exact lowercase keys are identities. Display name, meaning and firing condition are documentation only, never aliases or calculation inputs. Planned and active keys can be selected before receipt. Deprecated keys cannot start a new outcome schedule; saved schedules and runs keep their original meaning.</p>
    <p>Observation is separate from lifecycle: retained accepted logical events, not users, conversions or delivery completeness. Not observed means unknown, not a healthy zero. No lifecycle changes automatically on receipt. <a href="${app}/synthetic-validations">Confirm synthetic SDK receipt</a> in a disposable synthetic deployment only; this validation tool is unavailable on persistent databases.</p>
    <form method="get" action="${base}"><label>Exact key prefix <input name="prefix" maxlength="64" value="${escape(query.prefix)}"></label><input type="hidden" name="limit" value="${query.limit}"><button type="submit">Search</button></form>
    <table><caption>Current metadata and separate observations</caption><thead><tr><th scope="col">Event key</th><th scope="col">Display name</th><th scope="col">Lifecycle</th><th scope="col">Meaning</th><th scope="col">Firing condition</th><th scope="col">Observed receipt</th><th scope="col">Edit</th></tr></thead><tbody>${rows}</tbody></table>
    ${next ? `<p><a rel="next" href="${escape(next)}">Next page</a></p>` : ""}
    <section><h2>Plan an event</h2><p>Use non-personal documentation only. Case changes and the reserved platform event are not accepted.</p><form method="post" action="${base}">${fields()}<button type="submit">Register planned metadata</button></form></section>
    ${renderCustomConversionScheduleForm(`${app}/metric-schedules`, csrf, selectable)}
    ${renderMeasurementSetup(appId, token, selectable)}</main></body></html>`;
}
