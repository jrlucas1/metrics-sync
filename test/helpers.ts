import type { Clock } from '../src/clock';
import { FakeProviderTransport, type FakePost } from '../src/provider/fake-transport';
import { HttpMetricsProvider, type ProviderResponse } from '../src/provider/http-metrics-provider';
import type { SyncWindow } from '../src/provider/metrics-provider';
import { Store } from '../src/store';
import { SyncService, defaultSyncConfig, type SyncConfig } from '../src/sync-service';

export const START = '2026-10-11T12:00:00.000Z';

// Relógio controlado: sleep não espera, só anota o prazo e avança o tempo.
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(start = START) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export function post(id: string, publishedAt: string, overrides: Partial<FakePost> = {}): FakePost {
  return {
    id,
    publishedAt,
    measuredAt: '2026-10-10T08:00:00Z',
    views: 100,
    likes: 10,
    comments: 1,
    shares: 0,
    ...overrides,
  };
}

export function window(from: string, to: string): SyncWindow {
  return { from: new Date(from), to: new Date(to) };
}

export function rateLimited(retryAfter?: string): ProviderResponse {
  return {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    body: '{"error":"rate_limited"}',
  };
}

export function setup(posts: FakePost[] = [], config: Partial<SyncConfig> = {}) {
  const clock = new FakeClock();
  const transport = new FakeProviderTransport(posts);
  const provider = new HttpMetricsProvider(transport, clock);
  const store = new Store();
  const connection = store.createConnection('instagram', 'token-de-teste');
  const service = new SyncService(provider, store, clock, { ...defaultSyncConfig, ...config });
  return { clock, transport, provider, store, connection, service };
}
