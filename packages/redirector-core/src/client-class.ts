export type ClientClass = "mobile_app_eligible" | "bot" | "other";

/** Public, fixed classification tokens. Raw User-Agent values are never returned or persisted. */
export const PUBLIC_BOT_TOKENS = Object.freeze([
  "bot",
  "crawler",
  "spider",
  "preview",
] as const);

export function classifyClientClass(userAgent: string): ClientClass {
  const normalized = userAgent.toLocaleLowerCase("en-US");
  if (PUBLIC_BOT_TOKENS.some((token) => normalized.includes(token))) return "bot";
  if (/android|iphone|ipad/.test(normalized)) return "mobile_app_eligible";
  return "other";
}
