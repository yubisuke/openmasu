export type CiScopes = {
  contract: boolean;
  runtime: boolean;
  android: boolean;
  android_emulator: boolean;
  ios: boolean;
  runtime_performance: boolean;
};

export function classifyPaths(paths: readonly string[], eventName?: "pull_request" | "push"): CiScopes;
