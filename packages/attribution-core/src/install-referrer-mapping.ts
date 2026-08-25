export type InstallReferrerClientResponse = "ok" | "service_unavailable" | "feature_not_supported" | "developer_error" | "service_disconnected";

export type InstallReferrerMapping = {
  referrer_status: "available" | "none" | "unsupported" | "unavailable";
  referrer_client_response: InstallReferrerClientResponse;
  retry: "none" | "bounded";
  terminal_reason?: "unknown_click_id" | "no_referrer" | "install_referrer_unsupported" | "install_referrer_unavailable";
  requires_window_evaluation?: true;
  click_id?: string;
  loud_integrator_error?: true;
};

export function mapInstallReferrer(input: {
  response: InstallReferrerClientResponse;
  referrer?: string;
}): InstallReferrerMapping {
  if (input.response === "ok") {
    const value = input.referrer ?? "";
    if (!value) return { referrer_status: "none", referrer_client_response: "ok", retry: "none", terminal_reason: "no_referrer" };
    const clickId = new URLSearchParams(value).get("cid") ?? undefined;
    return {
      referrer_status: "available",
      referrer_client_response: "ok",
      retry: "none",
      ...(clickId ? { requires_window_evaluation: true as const } : { terminal_reason: "unknown_click_id" as const }),
      ...(clickId ? { click_id: clickId } : {}),
    };
  }
  if (input.response === "feature_not_supported") {
    return { referrer_status: "unsupported", referrer_client_response: input.response, retry: "none", terminal_reason: "install_referrer_unsupported" };
  }
  if (input.response === "developer_error") {
    return { referrer_status: "unavailable", referrer_client_response: input.response, retry: "none", terminal_reason: "install_referrer_unavailable", loud_integrator_error: true };
  }
  return { referrer_status: "unavailable", referrer_client_response: input.response, retry: "bounded", terminal_reason: "install_referrer_unavailable" };
}
