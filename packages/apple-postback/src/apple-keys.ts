// Public verification keys published by Apple and rechecked on 2026-08-20.
// These are public SPKI values, never private signing material.
export const APPLE_SKAN_PUBLIC_KEY_BASE64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==";

export const APPLE_AAK_PUBLIC_KEYS = {
  "apple-cas-identifier/0": APPLE_SKAN_PUBLIC_KEY_BASE64,
  "apple-development-identifier/0":
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELeEDzpJEP+/qRSE5hJVC1p1J0ssUnQGMzBBbvnACBok8OVGGLgxL0myrKiy6lvRtSlLRsWit87i+vftD8AEqeQ==",
  "apple-development-identifier/1":
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8YzdO7eM97s/IJ25kdW5CZ3A14USE5IJ5Ha/vhWaxI6UBI1ZxCEvjrKxVluVGe6qWwF1BDFq+QHqKfH5u+wxHQ==",
} as const;

export type AppleAakKeyId = keyof typeof APPLE_AAK_PUBLIC_KEYS;
