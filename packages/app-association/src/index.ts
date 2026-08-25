export type AppLinkIdentity = {
  readonly app_id: string;
  readonly android_package_name?: string;
  readonly android_sha256_fingerprints?: readonly string[];
  readonly apple_team_id?: string;
  readonly apple_bundle_id?: string;
};

const packagePattern = /^[A-Za-z][A-Za-z0-9_.]{2,254}$/;
const fingerprintPattern = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;
const teamPattern = /^[A-Z0-9]{10}$/;
const bundlePattern = /^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/;

export function validateAppLinkIdentity(identity: AppLinkIdentity): void {
  if (identity.android_package_name !== undefined && !packagePattern.test(identity.android_package_name)) {
    throw new Error("android_package_name_invalid");
  }
  const fingerprints = identity.android_sha256_fingerprints ?? [];
  if (fingerprints.length > 8) throw new Error("android_fingerprint_limit");
  for (const value of fingerprints) if (!fingerprintPattern.test(value)) throw new Error("android_fingerprint_invalid");
  if ((identity.apple_team_id === undefined) !== (identity.apple_bundle_id === undefined)) {
    throw new Error("apple_identity_incomplete");
  }
  if (identity.apple_team_id !== undefined && !teamPattern.test(identity.apple_team_id)) throw new Error("apple_team_id_invalid");
  if (identity.apple_bundle_id !== undefined && !bundlePattern.test(identity.apple_bundle_id)) throw new Error("apple_bundle_id_invalid");
}

export function assetLinksDocument(identities: readonly AppLinkIdentity[]): unknown[] {
  return [...identities]
    .filter((item) => item.android_package_name && item.android_sha256_fingerprints?.length)
    .sort((a, b) => a.app_id.localeCompare(b.app_id, "en"))
    .map((item) => {
      validateAppLinkIdentity(item);
      return {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: item.android_package_name,
          sha256_cert_fingerprints: [...item.android_sha256_fingerprints!].sort(),
        },
      };
    });
}

export function appleAssociationDocument(identities: readonly AppLinkIdentity[]): unknown {
  return {
    applinks: {
      details: [...identities]
        .filter((item) => item.apple_team_id && item.apple_bundle_id)
        .sort((a, b) => a.app_id.localeCompare(b.app_id, "en"))
        .map((item) => {
          validateAppLinkIdentity(item);
          return {
            appIDs: [`${item.apple_team_id}.${item.apple_bundle_id}`],
            components: [{ "/": "/r/*" }],
          };
        }),
    },
  };
}

export function associationBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}
