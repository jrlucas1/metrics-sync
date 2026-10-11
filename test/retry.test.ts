import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../src/provider/http-metrics-provider';
import { post, rateLimited, setup, START, window } from './helpers';

const WINDOW = window('2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z');
const POSTS = [
  post('a', '2026-10-02T10:00:00Z'),
  post('b', '2026-10-03T10:00:00Z'),
  post('c', '2026-10-04T10:00:00Z'),
];
const SERVER_ERROR = { status: 503, headers: {}, body: '' };

describe('falha transitória', () => {
  it('tenta de novo depois de um timeout e conclui', async () => {
    const { service, store, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith('timeout');

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'completed', providerCalls: 3, postsSaved: 3 });
    expect(clock.sleeps).toEqual([1_000]);
    expect(store.listPosts(connection.id)).toHaveLength(3);
  });

  it('para no teto de tentativas quando o provedor não volta', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith('timeout', SERVER_ERROR, 'timeout', SERVER_ERROR, 'ok');

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'failed', providerCalls: 4, error: { kind: 'unavailable' } });
    expect(result.retryAt).toBeUndefined();
    expect(transport.requests).toHaveLength(4);
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('o backoff não passa do teto configurado', async () => {
    const { service, connection, transport, clock } = setup(POSTS, {
      maxAttempts: 5,
      backoffMaxMs: 3_000,
    });
    transport.respondNextWith('timeout', 'timeout', 'timeout', 'timeout');

    const result = await service.sync(connection, WINDOW);

    expect(result.status).toBe('completed');
    expect(clock.sleeps).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it('o teto vale por página, não acumula entre páginas', async () => {
    const { service, connection, transport } = setup(POSTS, { maxAttempts: 2 });
    transport.respondNextWith('timeout', 'ok', 'timeout', 'ok');

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'completed', providerCalls: 4, postsSaved: 3 });
  });

  it('erro que não é transitório falha sem tentar de novo', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith({ status: 401, headers: {}, body: '' });

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'failed', providerCalls: 1, error: { kind: 'rejected' } });
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    ['corpo que não é JSON', 'isto não é json'],
    ['post sem id', '{"data":[{"metrics":{}}],"next_cursor":null}'],
    ['contador negativo', JSON.stringify({
      data: [{ id: 'a', published_at: '2026-10-02T10:00:00Z', measured_at: '2026-10-10T08:00:00Z', metrics: { views: -1, likes: 0, comments: 0, shares: 0 } }],
      next_cursor: null,
    })],
    ['data inválida', JSON.stringify({
      data: [{ id: 'a', published_at: 'ontem', measured_at: '2026-10-10T08:00:00Z', metrics: { views: 1, likes: 0, comments: 0, shares: 0 } }],
      next_cursor: null,
    })],
  ])('resposta inválida (%s) falha sem gravar', async (_name, body) => {
    const { service, store, connection, transport } = setup(POSTS);
    transport.respondNextWith({ status: 200, headers: {}, body });

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'failed', providerCalls: 1, error: { kind: 'invalid_response' } });
    expect(store.listPosts(connection.id)).toEqual([]);
  });

  it('cursor repetido encerra o sync em vez de girar para sempre', async () => {
    const { service, connection, transport } = setup(POSTS);
    const samePage = { status: 200, headers: {}, body: '{"data":[],"next_cursor":"2"}' };
    transport.respondNextWith(samePage, samePage, samePage);

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({ status: 'failed', providerCalls: 2, error: { kind: 'invalid_response' } });
  });

  it('o que foi gravado antes da falha fica, e repetir a janela não duplica', async () => {
    const { service, store, connection, transport } = setup(POSTS, { maxAttempts: 1 });
    transport.respondNextWith('ok', 'timeout');

    const failed = await service.sync(connection, WINDOW);
    expect(failed).toMatchObject({ status: 'failed', postsSaved: 2 });
    expect(store.listPosts(connection.id).map((p) => p.postId)).toEqual(['a', 'b']);

    const retried = await service.sync(connection, WINDOW);
    expect(retried).toMatchObject({ status: 'completed', postsReceived: 3 });
    expect(store.listPosts(connection.id).map((p) => p.postId)).toEqual(['a', 'b', 'c']);
  });
});

describe('429 do provedor', () => {
  it('espera exatamente o Retry-After e depois conclui', async () => {
    const { service, store, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('30'));

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({
      status: 'completed',
      providerCalls: 3,
      startedAt: START,
      finishedAt: '2026-10-11T12:00:30.000Z',
    });
    expect(clock.sleeps).toEqual([30_000]);
    // Buscado depois da espera, e é esse horário que fica gravado.
    expect(store.listPosts(connection.id)[0]?.fetchedAt).toBe('2026-10-11T12:00:30.000Z');
  });

  it('aceita Retry-After como data HTTP', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('Sun, 11 Oct 2026 12:00:45 GMT'));

    const result = await service.sync(connection, WINDOW);

    expect(result.status).toBe('completed');
    expect(clock.sleeps).toEqual([45_000]);
  });

  it('Retry-After igual ao teto ainda espera', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('60'));

    const result = await service.sync(connection, WINDOW);

    expect(result.status).toBe('completed');
    expect(clock.sleeps).toEqual([60_000]);
  });

  it('Retry-After acima do teto não espera e devolve o prazo', async () => {
    const { service, store, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('61'));

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({
      status: 'rate_limited',
      providerCalls: 1,
      error: { kind: 'rate_limited' },
      retryAt: '2026-10-11T12:01:01.000Z',
      finishedAt: START,
    });
    expect(clock.sleeps).toEqual([]);
    expect(store.listPosts(connection.id)).toEqual([]);
  });

  it('429 seguido de 429 para no teto de tentativas', async () => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited('10'), rateLimited('10'), rateLimited('10'), rateLimited('10'), 'ok');

    const result = await service.sync(connection, WINDOW);

    expect(result).toMatchObject({
      status: 'rate_limited',
      providerCalls: 4,
      // Três esperas de 10 s, mais os 10 s que o último 429 pediu.
      retryAt: '2026-10-11T12:00:40.000Z',
    });
    expect(clock.sleeps).toEqual([10_000, 10_000, 10_000]);
  });

  it.each([
    ['sem Retry-After', undefined],
    ['com Retry-After ilegível', 'daqui a pouco'],
    ['com Retry-After negativo', '-5'],
  ])('429 %s usa o backoff', async (_name, header) => {
    const { service, connection, transport, clock } = setup(POSTS);
    transport.respondNextWith(rateLimited(header), rateLimited(header));

    const result = await service.sync(connection, WINDOW);

    expect(result.status).toBe('completed');
    expect(clock.sleeps).toEqual([1_000, 2_000]);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date(START);

  it('lê segundos', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('lê data HTTP relativa ao relógio', () => {
    expect(parseRetryAfter('Sun, 11 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
  });

  it('data no passado vira espera zero', () => {
    expect(parseRetryAfter('Sun, 11 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('devolve undefined para ausente ou ilegível', () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('daqui a pouco', now)).toBeUndefined();
  });
});
