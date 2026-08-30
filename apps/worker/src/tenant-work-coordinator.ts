export const DEFAULT_WORKER_CONCURRENCY = 4;
export const MAX_WORKER_CONCURRENCY = 16;
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 30_000;
export const MAX_WORKER_SHUTDOWN_TIMEOUT_MS = 300_000;
export const DEFAULT_WORKER_INBOX_BATCH_LIMIT = 100;
export const MAX_WORKER_INBOX_BATCH_LIMIT = 1_000;

export function parseWorkerConcurrency(value: string | undefined): number {
  const concurrency = Number(value ?? String(DEFAULT_WORKER_CONCURRENCY));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKER_CONCURRENCY) {
    throw new Error(
      `OPENMASU_WORKER_CONCURRENCY must be an integer from 1 through ${MAX_WORKER_CONCURRENCY}`,
    );
  }
  return concurrency;
}

export function parseWorkerShutdownTimeout(value: string | undefined): number {
  const timeout = Number(value ?? String(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS));
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_WORKER_SHUTDOWN_TIMEOUT_MS) {
    throw new Error(
      `OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS must be an integer from 1000 through ${MAX_WORKER_SHUTDOWN_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

export function parseWorkerInboxBatchLimit(name: string, value: string | undefined): number {
  const limit = Number(value ?? String(DEFAULT_WORKER_INBOX_BATCH_LIMIT));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKER_INBOX_BATCH_LIMIT) {
    throw new Error(`${name} must be an integer from 1 through ${MAX_WORKER_INBOX_BATCH_LIMIT}`);
  }
  return limit;
}

export function workerPoolSizes(concurrency: number): {
  readonly jobs: number;
  readonly scheduler: number;
} {
  const bounded = parseWorkerConcurrency(String(concurrency));
  return { jobs: bounded * 2, scheduler: bounded };
}

type TenantWork = {
  readonly tenantId: string;
  readonly task: () => Promise<void>;
};

export type TenantWorkCoordinatorOptions = {
  readonly concurrency: number;
  readonly onFailure: (error: unknown) => void;
};

export class TenantWorkCoordinator {
  readonly #concurrency: number;
  readonly #onFailure: (error: unknown) => void;
  readonly #pendingTenants = new Set<string>();
  readonly #queue: TenantWork[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #active = 0;
  #closed = false;

  constructor(options: TenantWorkCoordinatorOptions) {
    this.#concurrency = parseWorkerConcurrency(String(options.concurrency));
    this.#onFailure = options.onFailure;
  }

  get active(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }

  submit(tenantId: string, task: () => Promise<void>): boolean {
    if (this.#closed || this.#pendingTenants.has(tenantId)) return false;
    this.#pendingTenants.add(tenantId);
    this.#queue.push({ tenantId, task });
    this.#pump();
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#resolveIdleWaiters();
  }

  async waitForIdle(): Promise<void> {
    if (this.#active === 0 && this.#queue.length === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #pump(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const work = this.#queue.shift();
      if (!work) break;
      this.#active += 1;
      void this.#run(work);
    }
    this.#resolveIdleWaiters();
  }

  async #run(work: TenantWork): Promise<void> {
    try {
      await work.task();
    } catch (error) {
      try { this.#onFailure(error); } catch { /* failure reporting must not stop queued tenants */ }
    } finally {
      this.#active -= 1;
      this.#pendingTenants.delete(work.tenantId);
      this.#pump();
    }
  }

  #resolveIdleWaiters(): void {
    if (this.#active !== 0 || this.#queue.length !== 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

export async function waitForWorkerDrain(
  coordinator: TenantWorkCoordinator,
  pendingPoll: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(drained);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.all([pendingPoll ?? Promise.resolve(), coordinator.waitForIdle()])
      .then(() => finish(true), () => finish(false));
  });
}
