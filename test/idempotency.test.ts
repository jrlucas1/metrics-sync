import { describe, expect, it } from 'vitest';
import { post, setup, START, window } from './helpers';

const OCT_1_TO_10 = window('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
const OCT_5_TO_15 = window('2026-10-05T00:00:00Z', '2026-10-15T00:00:00Z');

function totalViews(posts: { views: number }[]): number {
  return posts.reduce((sum, p) => sum + p.views, 0);
}

describe('idempotência do sync', () => {
  it('grava os posts da janela com o horário da busca', async () => {
    const { service, store, connection } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100 }),
      post('b', '2026-10-06T10:00:00Z', { views: 250 }),
    ]);

    const result = await service.sync(connection, OCT_1_TO_10);

    expect(result).toMatchObject({ status: 'completed', postsReceived: 2, postsSaved: 2 });
    expect(store.listPosts(connection.id)).toEqual([
      expect.objectContaining({ postId: 'a', views: 100, measuredAt: '2026-10-10T08:00:00.000Z', fetchedAt: START }),
      expect.objectContaining({ postId: 'b', views: 250, fetchedAt: START }),
    ]);
  });

  it('repetir a mesma janela não duplica nem soma', async () => {
    const { service, store, connection } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100 }),
      post('b', '2026-10-06T10:00:00Z', { views: 250 }),
    ]);

    await service.sync(connection, OCT_1_TO_10);
    await service.sync(connection, OCT_1_TO_10);

    const posts = store.listPosts(connection.id);
    expect(posts.map((p) => p.postId)).toEqual(['a', 'b']);
    expect(totalViews(posts)).toBe(350);
  });

  it('janelas sobrepostas contam o post da interseção uma vez', async () => {
    const { service, store, connection } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100 }),
      post('b', '2026-10-06T10:00:00Z', { views: 250 }),
      post('c', '2026-10-12T10:00:00Z', { views: 40 }),
    ]);

    await service.sync(connection, OCT_1_TO_10);
    await service.sync(connection, OCT_5_TO_15);

    const posts = store.listPosts(connection.id);
    expect(posts.map((p) => p.postId)).toEqual(['a', 'b', 'c']);
    expect(totalViews(posts)).toBe(390);
  });

  it('post repetido na resposta do provedor vira uma linha só', async () => {
    const repeated = post('a', '2026-10-02T10:00:00Z', { views: 100 });
    // Página de 2: o post se repete na mesma página e de novo na seguinte.
    const { service, store, connection } = setup([repeated, repeated, repeated]);

    const result = await service.sync(connection, OCT_1_TO_10);

    expect(result.postsReceived).toBe(3);
    expect(store.listPosts(connection.id)).toHaveLength(1);
    expect(totalViews(store.listPosts(connection.id))).toBe(100);
  });

  it('snapshot mais novo substitui os números e atualiza o horário da busca', async () => {
    const { service, store, connection, transport, clock } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100, measuredAt: '2026-10-10T08:00:00Z' }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    clock.advance(3_600_000);
    transport.setPosts([
      post('a', '2026-10-02T10:00:00Z', { views: 180, measuredAt: '2026-10-11T12:30:00Z' }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    expect(store.listPosts(connection.id)).toEqual([
      expect.objectContaining({
        views: 180,
        measuredAt: '2026-10-11T12:30:00.000Z',
        fetchedAt: '2026-10-11T13:00:00.000Z',
      }),
    ]);
  });

  it('snapshot mais velho que o gravado não faz o número regredir', async () => {
    const { service, store, connection, transport, clock } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 180, measuredAt: '2026-10-11T12:30:00Z' }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    clock.advance(3_600_000);
    transport.setPosts([
      post('a', '2026-10-02T10:00:00Z', { views: 100, measuredAt: '2026-10-10T08:00:00Z' }),
    ]);
    const result = await service.sync(connection, OCT_1_TO_10);

    expect(result).toMatchObject({ status: 'completed', postsReceived: 1, postsSaved: 0 });
    expect(store.listPosts(connection.id)).toEqual([
      expect.objectContaining({ views: 180, measuredAt: '2026-10-11T12:30:00.000Z', fetchedAt: START }),
    ]);
  });

  it('compara o instante da medição, não o texto com fuso', async () => {
    // 09:00-03:00 é 12:00Z, uma hora depois de 11:00Z.
    const { service, store, connection, transport } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100, measuredAt: '2026-10-10T11:00:00Z' }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    transport.setPosts([
      post('a', '2026-10-02T10:00:00Z', { views: 150, measuredAt: '2026-10-10T09:00:00-03:00' }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    expect(store.listPosts(connection.id)[0]).toMatchObject({
      views: 150,
      measuredAt: '2026-10-10T12:00:00.000Z',
    });
  });

  it('empate de medição: vale o último recebido', async () => {
    const { service, store, connection, transport } = setup([
      post('a', '2026-10-02T10:00:00Z', { views: 100 }),
    ]);
    await service.sync(connection, OCT_1_TO_10);

    transport.setPosts([post('a', '2026-10-02T10:00:00Z', { views: 101 })]);
    await service.sync(connection, OCT_1_TO_10);

    expect(store.listPosts(connection.id)).toEqual([expect.objectContaining({ views: 101 })]);
  });

  it('a janela inclui o início e exclui o fim', async () => {
    const { service, store, connection } = setup([
      post('no-inicio', '2026-10-01T00:00:00Z'),
      post('no-fim', '2026-10-10T00:00:00Z'),
    ]);

    await service.sync(connection, OCT_1_TO_10);

    expect(store.listPosts(connection.id).map((p) => p.postId)).toEqual(['no-inicio']);
  });

  it('conexões diferentes não dividem a linha do mesmo post', async () => {
    const { service, store, connection } = setup([post('a', '2026-10-02T10:00:00Z')]);
    const other = store.createConnection('tiktok', 'outro-token');

    await service.sync(connection, OCT_1_TO_10);
    await service.sync(other, OCT_1_TO_10);

    expect(store.listPosts(connection.id)).toHaveLength(1);
    expect(store.listPosts(other.id)).toHaveLength(1);
  });
});
