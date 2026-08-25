import { createPublicKey, verify } from "node:crypto";
import { APPLE_AAK_PUBLIC_KEYS, APPLE_SKAN_PUBLIC_KEY_BASE64, type AppleAakKeyId } from "./apple-keys.js";

type JsonObject = Record<string, unknown>;
type VerificationFailureReason =
  | "malformed"
  | "signature_invalid"
  | "unknown_key"
  | "development_postback_rejected";

export type VerificationResult =
  | {
      readonly verified: true;
      readonly authenticated: JsonObject;
      readonly unsigned: JsonObject;
      readonly signingKeyEnvironment: "production" | "development";
    }
  | {
      readonly verified: false;
      readonly reason: VerificationFailureReason;
      readonly unsigned: JsonObject;
      readonly signingKeyEnvironment?: "production" | "development";
      readonly unverifiedClaims?: JsonObject;
    };

export const unsignedApplePostbackEvidenceNotice =
  "Conversion values, coarse conversion values, interaction type, and country can be outside Apple's signature. They remain unsigned observations and never become authenticated evidence.";

const separator = "\u2063";

function publicKey(base64: string) {
  return createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${name}`);
  return value;
}

function requiredInteger(value: unknown, name: string): string {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`invalid_${name}`);
  return String(value);
}

function requiredBoolean(value: unknown, name: string): string {
  if (typeof value !== "boolean") throw new Error(`invalid_${name}`);
  return String(value);
}

function optionalInteger(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredInteger(value, name);
}

export function skanSignedMessage(body: JsonObject): string {
  const version = requiredString(body.version, "version");
  const major = Number(version.split(".")[0]);
  const common = [
    version,
    requiredString(body["ad-network-id"], "ad-network-id"),
  ];
  if (major === 3) {
    const fields = [
      ...common,
      requiredInteger(body["campaign-id"], "campaign-id"),
      requiredInteger(body["app-id"], "app-id"),
      requiredString(body["transaction-id"], "transaction-id"),
      requiredBoolean(body.redownload, "redownload"),
    ];
    const sourceAppId = optionalInteger(body["source-app-id"], "source-app-id");
    if (sourceAppId !== undefined) fields.push(sourceAppId);
    fields.push(
      requiredInteger(body["fidelity-type"], "fidelity-type"),
      requiredBoolean(body["did-win"], "did-win"),
    );
    return fields.join(separator);
  }
  if (major === 4) {
    const source = body["source-app-id"] !== undefined
      ? requiredInteger(body["source-app-id"], "source-app-id")
      : requiredString(body["source-domain"], "source-domain");
    return [
      ...common,
      requiredString(body["source-identifier"], "source-identifier"),
      requiredInteger(body["app-id"], "app-id"),
      requiredString(body["transaction-id"], "transaction-id"),
      requiredBoolean(body.redownload, "redownload"),
      source,
      requiredInteger(body["fidelity-type"], "fidelity-type"),
      requiredBoolean(body["did-win"], "did-win"),
      requiredInteger(body["postback-sequence-index"], "postback-sequence-index"),
    ].join(separator);
  }
  throw new Error("unsupported_version");
}

const skanUnsignedFields = ["conversion-value", "coarse-conversion-value", "country-code"] as const;

export function verifySkAdNetworkPostback(
  body: JsonObject,
  options: { readonly publicKeyBase64?: string } = {},
): VerificationResult {
  const unsigned = Object.fromEntries(skanUnsignedFields.flatMap((name) =>
    body[name] === undefined ? [] : [[name, body[name]]],
  ));
  try {
    const signature = requiredString(body["attribution-signature"], "attribution-signature");
    const valid = verify(
      "sha256",
      Buffer.from(skanSignedMessage(body), "utf8"),
      publicKey(options.publicKeyBase64 ?? APPLE_SKAN_PUBLIC_KEY_BASE64),
      Buffer.from(signature, "base64"),
    );
    if (!valid) return { verified: false, reason: "signature_invalid", unsigned, signingKeyEnvironment: "production" };
    const authenticated = Object.fromEntries(Object.entries(body).filter(([name]) =>
      name !== "attribution-signature" && !skanUnsignedFields.includes(name as typeof skanUnsignedFields[number]),
    ));
    return { verified: true, authenticated, unsigned, signingKeyEnvironment: "production" };
  } catch {
    return { verified: false, reason: "malformed", unsigned };
  }
}

function decodeBase64UrlJson(value: string): JsonObject {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_object");
  return parsed as JsonObject;
}

function keyEnvironment(kid: string): "production" | "development" | undefined {
  if (kid === "apple-cas-identifier/0") return "production";
  if (kid === "apple-development-identifier/0" || kid === "apple-development-identifier/1") return "development";
  return undefined;
}

const aakUnsignedFields = ["conversion-value", "coarse-conversion-value", "ad-interaction-type", "country-code"] as const;

export function verifyAdAttributionKitPostback(
  body: JsonObject,
  options: {
    readonly acceptDevelopmentPostbacks?: boolean;
    readonly keySet?: Readonly<Record<string, string>>;
  } = {},
): VerificationResult {
  const unsigned = Object.fromEntries(aakUnsignedFields.flatMap((name) =>
    body[name] === undefined ? [] : [[name, body[name]]],
  ));
  try {
    const jws = requiredString(body["jws-string"], "jws-string");
    const parts = jws.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { verified: false, reason: "malformed", unsigned };
    const header = decodeBase64UrlJson(parts[0]);
    const unverifiedClaims = decodeBase64UrlJson(parts[1]);
    if (header.alg !== "ES256" || typeof header.kid !== "string") return { verified: false, reason: "malformed", unsigned };
    const environment = keyEnvironment(header.kid);
    if (!environment) return { verified: false, reason: "unknown_key", unsigned, unverifiedClaims };
    if (environment === "development" && !options.acceptDevelopmentPostbacks) {
      return {
        verified: false,
        reason: "development_postback_rejected",
        unsigned,
        signingKeyEnvironment: environment,
        unverifiedClaims,
      };
    }
    const keys = options.keySet ?? APPLE_AAK_PUBLIC_KEYS;
    const encodedKey = keys[header.kid as AppleAakKeyId];
    if (!encodedKey) {
      return { verified: false, reason: "unknown_key", unsigned, signingKeyEnvironment: environment, unverifiedClaims };
    }
    const valid = verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      { key: publicKey(encodedKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid) {
      return { verified: false, reason: "signature_invalid", unsigned, signingKeyEnvironment: environment, unverifiedClaims };
    }
    return {
      verified: true,
      authenticated: unverifiedClaims,
      unsigned,
      signingKeyEnvironment: environment,
    };
  } catch {
    return { verified: false, reason: "malformed", unsigned };
  }
}

export { APPLE_AAK_PUBLIC_KEYS, APPLE_SKAN_PUBLIC_KEY_BASE64 } from "./apple-keys.js";
