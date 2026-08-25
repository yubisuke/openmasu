import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import { sha256, type CommerceLifecycleEvent } from "@openmasu/commerce-lifecycle";

export async function recordCommerceNotification(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly tenantId: string;
  readonly appId: string;
  readonly payload: Buffer;
  readonly notificationDigest: string;
  readonly subjectDigest?: string;
  readonly event: CommerceLifecycleEvent;
  readonly receivedAt: Date;
  readonly readbackOperation?: "google_subscription" | "google_order_refund" | "apple_transaction_history" | "apple_refund_history";
}): Promise<boolean> {
  const lifecycleFactId = uuidV7(input.receivedAt.getTime());
  const evidenceRef = await input.payloadStore.write(
    { tenantId: input.tenantId, appId: input.appId, objectId: `commerce-${input.event.provider}-${lifecycleFactId}` },
    input.payload,
  );
  try {
    const inserted = await withTenant(input.pool, input.tenantId, async (client) => {
      const notification = await client.query(
        `INSERT INTO control.commerce_provider_notifications (
           provider, notification_digest, tenant_id, app_id, event_kind, subject_digest,
           evidence_ref, payload_digest, occurred_at, received_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [input.event.provider, input.notificationDigest, input.tenantId, input.appId, input.event.eventKind,
          input.subjectDigest ?? null, evidenceRef, sha256(input.payload), input.event.effectiveAt, input.receivedAt.toISOString()],
      );
      if (notification.rowCount !== 1) return false;
      const artifact = {
        lifecycle_fact_id: lifecycleFactId,
        tenant_id: input.tenantId,
        app_id: input.appId,
        provider: input.event.provider,
        event_kind: input.event.eventKind,
        subject_digest: input.subjectDigest,
        transaction_digest: input.event.transactionDigest,
        original_transaction_digest: input.event.originalTransactionDigest,
        subscription_state: input.event.subscriptionState,
        financial_effect: input.event.financialEffect,
        environment: input.event.environment,
        effective_at: input.event.effectiveAt,
        recorded_at: input.receivedAt.toISOString(),
      };
      await client.query(
        `INSERT INTO ledger.commerce_lifecycle_facts (
           lifecycle_fact_id, provider, tenant_id, app_id, notification_digest, provider_event_digest, event_kind,
           subject_digest, transaction_digest, original_transaction_digest, subscription_state,
           financial_effect, environment, effective_at, recorded_at, artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [artifact.lifecycle_fact_id, input.event.provider, input.tenantId, input.appId, input.notificationDigest,
          input.event.externalEventDigest, input.event.eventKind, input.subjectDigest ?? null, input.event.transactionDigest ?? null,
          input.event.originalTransactionDigest ?? null, input.event.subscriptionState ?? null,
          input.event.financialEffect, input.event.environment ?? null, input.event.effectiveAt,
          input.receivedAt.toISOString(), JSON.stringify(artifact)],
      );
      if (input.readbackOperation) {
        await client.query(
          `INSERT INTO ephemeral.commerce_provider_readbacks (
             readback_id, provider, tenant_id, app_id, notification_digest, operation,
             next_attempt_at, requested_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [uuidV7(input.receivedAt.getTime() + 1), input.event.provider, input.tenantId, input.appId,
            input.notificationDigest, input.readbackOperation, input.receivedAt.toISOString(), input.receivedAt.toISOString()],
        );
      }
      return true;
    });
    if (!inserted) await input.payloadStore.purge(evidenceRef);
    return inserted;
  } catch (error) {
    await input.payloadStore.purge(evidenceRef);
    throw error;
  }
}
