#ifndef OPENMASU_OBJC_H
#define OPENMASU_OBJC_H

#include <stdbool.h>
#include <stdint.h>

typedef void (*OpenMasuCStringCallback)(int64_t request_id, const char *value);

void openmasu_ios_initialize(
  const char *endpoint,
  const char *sdk_key_id,
  const char *sdk_secret,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_track_custom_event(
  const char *event_key,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_record_conversion(
  const char *event_name,
  int32_t target_mask,
  const char *conversion_tag,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_track_purchase(
  const char *transaction_id,
  const char *amount_unscaled,
  int32_t amount_scale,
  const char *currency,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_track_refund(
  const char *transaction_id,
  const char *original_transaction_id,
  const char *amount_unscaled,
  int32_t amount_scale,
  const char *currency,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
/* Preparation is private retry state; pending is not verified revenue or an entitlement. */
void openmasu_ios_prepare_app_store_purchase(
  const char *product_id,
  const char *purchase_request_id,
  bool revenue_measurement_consent,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_submit_app_store_purchase(
  const char *encoded_preparation,
  const char *signed_transaction,
  bool revenue_measurement_consent,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_update_consent(
  const char *state,
  const char *policy_version,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_track_max_revenue(
  double revenue,
  const char *precision,
  const char *network_name,
  const char *ad_unit_id,
  const char *format,
  const char *placement,
  const char *network_placement,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_start_session(int64_t request_id, OpenMasuCStringCallback callback);
void openmasu_ios_set_collection_enabled(bool enabled);
void openmasu_ios_reset_installation(int64_t request_id, OpenMasuCStringCallback callback);
void openmasu_ios_ping_from_background(
  const char *value,
  int64_t request_id,
  OpenMasuCStringCallback callback
);
void openmasu_ios_handle_deep_link(
  const char *url,
  int64_t request_id,
  OpenMasuCStringCallback callback
);

#endif
