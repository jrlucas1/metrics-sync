import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { Store } from '../src/store';
import { post, setup, START, window } from './helpers';

const WINDOW = window('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
const BODY = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };
const PUBLISHED = '2026-10-02T10:00:00Z';

describe('histórico de snapshots', () => {
  it('guarda cada medição e devolve a série em ordem de medição', async () => {
    const { service, store, connection, transport, clock } = setup([
      post('a', PUBLISHED, { views: 100, measuredAt: '2026-10-10T08:00:00Z' }),
    ]);
    await service.sync(connection, WINDOW);

    clock.advance(3_600_000);
    transport.setPosts([post('a', PUBLISHED, { views: 180, measuredAt: '2026-10-11T12:30:00Z' })]);
    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a')).toEqual([
      { measuredAt: '2026-10-10T08:00:00.000Z', fetchedAt: START, views: 100, likes: 10, comments: 1, shares: 0 },
      { measuredAt: '2026-10-11T12:30:00.000Z', fetchedAt: '2026-10-11T13:00:00.000Z', views: 180, likes: 10, comments: 1, shares: 0 },
    ]);
    expect(store.findPost(connection.id, 'a')).toMatchObject({ views: 180 });
  });

  it('repetir a mesma medição não cria outro ponto na série', async () => {
    const { service, store, connection } = setup([post('a', PUBLISHED), post('a', PUBLISHED)]);

    await service.sync(connection, WINDOW);
    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a')).toHaveLength(1);
  });

  it('medição atrasada entra na série no lugar certo e não muda o atual', async () => {
    const { service, store, connection, transport } = setup([
      post('a', PUBLISHED, { views: 180, measuredAt: '2026-10-11T12:30:00Z' }),
    ]);
    await service.sync(connection, WINDOW);

    transport.setPosts([post('a', PUBLISHED, { views: 100, measuredAt: '2026-10-10T08:00:00Z' })]);
    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a').map((s) => s.views)).toEqual([100, 180]);
    expect(store.findPost(connection.id, 'a')).toMatchObject({
      views: 180,
      measuredAt: '2026-10-11T12:30:00.000Z',
    });
  });

  it('empate de medição: o ponto fica com o último recebido, como o atual', async () => {
    const { service, store, connection, transport } = setup([post('a', PUBLISHED, { views: 100 })]);
    await service.sync(connection, WINDOW);

    transport.setPosts([post('a', PUBLISHED, { views: 101 })]);
    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a').map((s) => s.views)).toEqual([101]);
  });

  it('o mesmo instante escrito em outro fuso é o mesmo ponto', async () => {
    const { service, store, connection, transport } = setup([
      post('a', PUBLISHED, { measuredAt: '2026-10-10T12:00:00Z' }),
    ]);
    await service.sync(connection, WINDOW);

    transport.setPosts([post('a', PUBLISHED, { measuredAt: '2026-10-10T09:00:00-03:00' })]);
    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a').map((s) => s.measuredAt)).toEqual([
      '2026-10-10T12:00:00.000Z',
    ]);
  });

  it('não mistura a série de outro post nem de outra conexão', async () => {
    const { service, store, connection } = setup([post('a', PUBLISHED), post('b', PUBLISHED)]);
    const other = store.createConnection('tiktok', 'outro-token');

    await service.sync(connection, WINDOW);

    expect(store.listSnapshots(connection.id, 'a')).toHaveLength(1);
    expect(store.listSnapshots(other.id, 'a')).toEqual([]);
    expect(store.findPost(other.id, 'a')).toBeUndefined();
  });

  it('a série continua no banco depois de reabrir o arquivo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-sync-'));
    try {
      const path = join(dir, 'metrics.db');
      const store = new Store(path);
      const connection = store.createConnection('youtube', 'token-de-teste');
      const snapshot = { postId: 'a', publishedAt: new Date(PUBLISHED), views: 1, likes: 0, comments: 0, shares: 0 };
      store.saveSnapshots(connection.id, [{ ...snapshot, measuredAt: new Date('2026-10-10T08:00:00Z') }], new Date(START));
      store.saveSnapshots(connection.id, [{ ...snapshot, measuredAt: new Date('2026-10-11T08:00:00Z') }], new Date(START));
      store.close();

      const reopened = new Store(path);
      expect(reopened.listSnapshots(connection.id, 'a')).toHaveLength(2);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /connections/:id/posts/:postId/snapshots', () => {
  let app: FastifyInstance;
  afterEach(() => app.close());

  it('devolve o atual e a série', async () => {
    const context = setup([post('a', PUBLISHED, { views: 100, measuredAt: '2026-10-10T08:00:00Z' })]);
    app = buildApp(context);
    const id = context.connection.id;
    await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });
    context.transport.setPosts([post('a', PUBLISHED, { views: 180, measuredAt: '2026-10-11T12:30:00Z' })]);
    await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });

    const response = await app.inject({ method: 'GET', url: `/connections/${id}/posts/a/snapshots` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      current: expect.objectContaining({ postId: 'a', views: 180, measuredAt: '2026-10-11T12:30:00.000Z' }),
      snapshots: [
        expect.objectContaining({ views: 100, measuredAt: '2026-10-10T08:00:00.000Z' }),
        expect.objectContaining({ views: 180, measuredAt: '2026-10-11T12:30:00.000Z' }),
      ],
    });
  });

  it('post ou conexão que não existe responde 404', async () => {
    const context = setup([post('a', PUBLISHED)]);
    app = buildApp(context);
    const id = context.connection.id;
    await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });

    const noPost = await app.inject({ method: 'GET', url: `/connections/${id}/posts/nao-existe/snapshots` });
    const noConnection = await app.inject({ method: 'GET', url: '/connections/nao-existe/posts/a/snapshots' });

    expect(noPost.statusCode).toBe(404);
    expect(noConnection.statusCode).toBe(404);
  });
});
