import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import { type ApplePostbackReceiverDependencies } from "./apple-postback-receiver.js";
import { type MaxReceiverConfig } from "./max-receiver.js";
import type { OperationalMetrics } from "./operational-metrics.js";
import { type OperationalLogWriter } from "./observability.js";
import type { KeyedTokenBucket, TokenBucket } from "./rate-limit.js";
import type { SdkRouteDependencies } from "./sdk-routes.js";
import { type GooglePlayRtdnReceiverDependencies } from "./google-play-rtdn-receiver.js";
import { type ServerRouteDependencies } from "./server-routes.js";
import { type AppleStoreNotificationDependencies } from "./apple-store-notifications-receiver.js";

export type DashboardConfig = {
  readonly enabled: boolean;
  readonly publicBaseUrl: string;
  readonly tenantId: string;
  readonly sessionTtlSeconds: number;
};

export type RequestHandlerDependencies = {
  readonly pool: Pool;
  readonly readerPool: Pool;
  readonly payloadStore: PayloadStore;
  readonly maxConfig: MaxReceiverConfig;
  readonly publicBaseUrl: string;
  readonly redirectorBaseUrl: string;
  readonly dashboard: DashboardConfig;
  readonly maxBucket?: TokenBucket;
  readonly adminBucket?: TokenBucket;
  readonly dashboardLoginBucket?: KeyedTokenBucket;
  readonly dashboardLoginGlobalBucket?: TokenBucket;
  readonly sdk?: SdkRouteDependencies;
  readonly server?: ServerRouteDependencies;
  readonly privacySubjectDigestKey?: string;
  readonly trackingDestinationAllowlist?: readonly string[];
  readonly operatorWebhooks?: Readonly<{
    destinationAllowlist: readonly string[];
    allowSyntheticLoopback?: boolean;
  }>;
  readonly operatorBulkExports?: Readonly<{
    destinationAllowlist: readonly string[];
    allowSyntheticLoopback?: boolean;
  }>;
  readonly referrerMaximumEncodedCharacters?: number;
  readonly reportMaximumRows?: number;
  readonly reportMaximumExportRows?: number;
  readonly applePostback?: ApplePostbackReceiverDependencies;
  readonly googlePlayRtdn?: GooglePlayRtdnReceiverDependencies;
  readonly appleStoreNotifications?: AppleStoreNotificationDependencies;
  readonly operationalMetrics?: OperationalMetrics;
  readonly operationalLogWriter?: OperationalLogWriter;
};
