import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { MetricsProvider } from '../src/provider/metrics-provider';
import { SyncService } from '../src/sync-service';
import { post, setup, window } from './helpers';

const WINDOW = window('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
const BODY = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };
// Três posts em páginas de dois: um sync inteiro faz duas chamadas ao provedor.
const POSTS = [
  post('a', '2026-10-02T10:00:00Z'),
  post('b', '2026-10-03T10:00:00Z'),
  post('c', '2026-10-04T10:00:00Z'),
];

describe('um sync por conexão por vez', () => {
  it('o segundo sync da mesma conexão é recusado sem chamar o provedor', async () => {
    const { service, connection, transport } = setup(POSTS);

    const [first, second] = await Promise.all([
      service.sync(connection, WINDOW),
      service.sync(connection, WINDOW),
    ]);

    expect(first).toMatchObject({ status: 'completed', providerCalls: 2, postsSaved: 3 });
    expect(second).toMatchObject({ status: 'already_running', providerCalls: 0, postsSaved: 0 });
    expect(transport.requests).toHaveLength(2);
  });

  it('conexões diferentes sincronizam ao mesmo tempo', async () => {
    const { service, store, connection } = setup(POSTS);
    const other = store.createConnection('tiktok', 'outro-token');

    const results = await Promise.all([service.sync(connection, WINDOW), service.sync(other, WINDOW)]);

    expect(results.map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('a trava solta quando o sync termina', async () => {
    const { service, connection } = setup(POSTS);

    await service.sync(connection, WINDOW);
    const again = await service.sync(connection, WINDOW);

    expect(again.status).toBe('completed');
  });

  it('a trava solta quando o sync falha', async () => {
    const { service, connection, transport } = setup(POSTS);
    transport.respondNextWith({ status: 401, headers: {}, body: '' });

    const failed = await service.sync(connection, WINDOW);
    const again = await service.sync(connection, WINDOW);

    expect(failed.status).toBe('failed');
    expect(again.status).toBe('completed');
  });

  it('a trava solta quando o sync estoura um erro inesperado', async () => {
    const { store, connection, clock, provider } = setup(POSTS);
    let broken = true;
    const flaky: MetricsProvider = {
      fetchPosts: async (...args) => {
        if (broken) throw new Error('bug no adaptador');
        return provider.fetchPosts(...args);
      },
    };
    const service = new SyncService(flaky, store, clock);

    await expect(service.sync(connection, WINDOW)).rejects.toThrow('bug no adaptador');
    broken = false;

    expect((await service.sync(connection, WINDOW)).status).toBe('completed');
  });
});

describe('POST /connections/:id/sync concorrente', () => {
  let app: FastifyInstance;
  afterEach(() => app.close());

  it('a requisição que chega durante um sync recebe 409', async () => {
    const context = setup(POSTS);
    // O provedor segura a primeira chamada até o teste liberar, para o primeiro
    // sync ainda estar em andamento quando a segunda requisição chega.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: MetricsProvider = {
      fetchPosts: async (...args) => {
        await held;
        return context.provider.fetchPosts(...args);
      },
    };
    app = buildApp({ ...context, provider: slow });
    const url = `/connections/${context.connection.id}/sync`;

    // O inject só dispara a requisição quando alguém chama o then.
    const first = app.inject({ method: 'POST', url, payload: BODY }).then((response) => response);
    const second = await app.inject({ method: 'POST', url, payload: BODY });
    release();

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ status: 'already_running', providerCalls: 0 });
    expect((await first).statusCode).toBe(200);
    expect(context.transport.requests).toHaveLength(2);
    expect(context.store.listPosts(context.connection.id)).toHaveLength(3);
  });
});
