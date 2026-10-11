import { buildApp } from './app';
import { systemClock } from './clock';
import { FakeProviderTransport, type FakePost } from './provider/fake-transport';
import { HttpMetricsProvider } from './provider/http-metrics-provider';
import { Store } from './store';

const seedPosts: FakePost[] = [
  { id: 'p1', publishedAt: '2026-10-01T12:00:00Z', measuredAt: '2026-10-10T08:00:00Z', views: 1200, likes: 90, comments: 12, shares: 4 },
  { id: 'p2', publishedAt: '2026-10-03T18:30:00Z', measuredAt: '2026-10-10T08:00:00Z', views: 5400, likes: 410, comments: 37, shares: 22 },
  { id: 'p3', publishedAt: '2026-10-07T09:15:00Z', measuredAt: '2026-10-10T08:00:00Z', views: 800, likes: 51, comments: 3, shares: 1 },
];

const app = buildApp({
  store: new Store(process.env.DB_PATH ?? 'metrics.db'),
  provider: new HttpMetricsProvider(new FakeProviderTransport(seedPosts), systemClock),
  clock: systemClock,
});

const address = await app.listen({ port: Number(process.env.PORT ?? 3000) });
console.log(`ouvindo em ${address}`);
