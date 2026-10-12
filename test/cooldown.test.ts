import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { FakeProviderTransport } from '../src/provider/fake-transport';
import { HttpMetricsProvider } from '../src/provider/http-metrics-provider';
import { Store } from '../src/store';
import { SyncService } from '../src/sync-service';
import { FakeClock, post, rateLimited, setup, window } from './helpers';

const WINDOW = window('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
const BODY = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };
const POSTS = [post('a', '2026-10-02T10:00:00Z')];
// O relógio dos testes começa em 12:00:00 e o provedor pede 90 s.
const RETRY_AT = '2026-10-11T12:01:30.000Z';

describe('cooldown do 429 por conexão', () => {
  it('sync novo antes do retry_at não chama o provedor e devolve o mesmo prazo', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('90'));
    await service.sync(connection, WINDOW);

    clock.advance(30_000);
    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({
      status: 'rate_limited',
      providerCalls: 0,
      error: { kind: 'rate_limited' },
      retryAt: RETRY_AT,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('um milissegundo antes do retry_at ainda não chama; no retry_at chama', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('90'));
    await service.sync(connection, WINDOW);

    clock.advance(89_999);
    expect((await service.sync(connection, WINDOW)).status).toBe('rate_limited');
    expect(transport.requests).toHaveLength(1);

    clock.advance(1);
    expect(await service.sync(connection, WINDOW)).toMatchObject({ status: 'completed', providerCalls: 1 });
    expect(transport.requests).toHaveLength(2);
  });

  it('o cooldown de uma conexão não segura a outra', async () => {
    const { service, store, connection, transport } = setup(POSTS);
    const other = store.createConnection('tiktok', 'outro-token');
    transport.respondNextWith(rateLimited('90'));
    await service.sync(connection, WINDOW);

    const result = await service.sync(other, WINDOW);

    expect(result).toMatchObject({ status: 'completed', providerCalls: 1 });
  });

  it('429 até o teto de tentativas também grava o cooldown', async () => {
    const { service, connection, transport } = setup(POSTS);
    transport.respondNextWith(rateLimited('10'), rateLimited('10'), rateLimited('10'), rateLimited('10'));
    const stopped = await service.sync(connection, WINDOW);

    const result = await service.sync(connection, WINDOW);

    expect(stopped).toMatchObject({ status: 'rate_limited', retryAt: '2026-10-11T12:00:40.000Z' });
    expect(result).toMatchObject({ status: 'rate_limited', providerCalls: 0, retryAt: '2026-10-11T12:00:40.000Z' });
    expect(transport.requests).toHaveLength(4);
  });

  it('falha que não é 429 não grava cooldown', async () => {
    const { service, connection, transport } = setup(POSTS, { maxAttempts: 1 });
    transport.respondNextWith('timeout');
    await service.sync(connection, WINDOW);

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'completed', providerCalls: 1 });
  });

  it('um 429 novo depois do prazo troca o retry_at', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('90'));
    await service.sync(connection, WINDOW);

    clock.advance(90_000);
    transport.respondNextWith(rateLimited('120'));
    await service.sync(connection, WINDOW);
    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ providerCalls: 0, retryAt: '2026-10-11T12:03:30.000Z' });
    expect(transport.requests).toHaveLength(2);
  });

  it('o cooldown está no banco: vale depois de reabrir o arquivo com outro serviço', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-sync-'));
    try {
      const path = join(dir, 'metrics.db');
      const clock = new FakeClock();
      const transport = new FakeProviderTransport(POSTS);
      const provider = new HttpMetricsProvider(transport, clock);

      const store = new Store(path);
      const connection = store.createConnection('instagram', 'token-de-teste');
      transport.respondNextWith(rateLimited('90'));
      await new SyncService(provider, store, clock).sync(connection, WINDOW);
      store.close();

      const reopened = new Store(path);
      const result = await new SyncService(provider, reopened, clock).sync(connection, WINDOW);
      reopened.close();

      expect(result).toMatchObject({ status: 'rate_limited', providerCalls: 0, retryAt: RETRY_AT });
      expect(transport.requests).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('POST /connections/:id/sync em cooldown', () => {
  let app: FastifyInstance;
  afterEach(() => app.close());

  it('responde 503 com o Retry-After que falta, sem chamar o provedor', async () => {
    const context = setup(POSTS);
    app = buildApp(context);
    const url = `/connections/${context.connection.id}/sync`;
    context.transport.respondNextWith(rateLimited('90'));
    await app.inject({ method: 'POST', url, payload: BODY });

    context.clock.advance(30_000);
    const response = await app.inject({ method: 'POST', url, payload: BODY });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.json()).toMatchObject({ status: 'rate_limited', providerCalls: 0, retryAt: RETRY_AT });
    expect(context.transport.requests).toHaveLength(1);
  });
});
