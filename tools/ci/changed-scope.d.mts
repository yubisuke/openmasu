export type CiScopes = {
  contract: boolean;
  runtime: boolean;
  android: boolean;
  android_emulator: boolean;
  ios: boolean;
};

export function classifyPaths(paths: readonly string[]): CiScopes;
