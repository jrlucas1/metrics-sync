import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { post, rateLimited, setup, START } from './helpers';

const BODY = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' };

let app: FastifyInstance;
afterEach(() => app.close());

function start() {
  const context = setup([post('a', '2026-10-02T10:00:00Z', { views: 100 })]);
  app = buildApp(context);
  return context;
}

async function createConnection(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/connections',
    payload: { platform: 'youtube', accessToken: 'token-ficticio' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}

describe('API', () => {
  it('cria a conexão, sincroniza e lista os posts com o horário da busca', async () => {
    start();
    const id = await createConnection();

    const sync = await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ status: 'completed', postsSaved: 1 });

    const posts = await app.inject({ method: 'GET', url: `/connections/${id}/posts` });
    expect(posts.json()).toEqual({
      posts: [expect.objectContaining({ postId: 'a', views: 100, fetchedAt: START })],
    });
  });

  it('não devolve o token da conexão', async () => {
    start();
    const response = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { platform: 'x', accessToken: 'token-ficticio' },
    });
    expect(response.body).not.toContain('token-ficticio');
  });

  it('manda o token e a plataforma da conexão para o provedor', async () => {
    const { transport } = start();
    const id = await createConnection();

    await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });

    expect(transport.requests[0]).toMatchObject({
      headers: { authorization: 'Bearer token-ficticio' },
      query: { platform: 'youtube', from: '2026-10-01T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' },
    });
  });

  it('429 acima do teto vira 503 com Retry-After', async () => {
    const { transport } = start();
    const id = await createConnection();
    transport.respondNextWith(rateLimited('90'));

    const sync = await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });

    expect(sync.statusCode).toBe(503);
    expect(sync.headers['retry-after']).toBe('90');
    expect(sync.json()).toMatchObject({ status: 'rate_limited', retryAt: '2026-10-11T12:01:30.000Z' });
  });

  it('falha do provedor vira 502', async () => {
    const { transport } = start();
    const id = await createConnection();
    transport.respondNextWith({ status: 401, headers: {}, body: '' });

    const sync = await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: BODY });

    expect(sync.statusCode).toBe(502);
    expect(sync.json()).toMatchObject({ status: 'failed', error: { kind: 'rejected' } });
  });

  it.each([
    ['from depois de to', { from: BODY.to, to: BODY.from }],
    ['janela vazia', { from: BODY.from, to: BODY.from }],
    ['data inválida', { from: 'ontem', to: BODY.to }],
    ['campo faltando', { from: BODY.from }],
  ])('recusa janela inválida: %s', async (_name, payload) => {
    const { transport } = start();
    const id = await createConnection();

    const sync = await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload });

    expect(sync.statusCode).toBe(400);
    expect(transport.requests).toHaveLength(0);
  });

  it('recusa plataforma desconhecida', async () => {
    start();
    const response = await app.inject({
      method: 'POST',
      url: '/connections',
      payload: { platform: 'orkut', accessToken: 'token-ficticio' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('conexão inexistente responde 404', async () => {
    start();
    const sync = await app.inject({ method: 'POST', url: '/connections/nao-existe/sync', payload: BODY });
    const posts = await app.inject({ method: 'GET', url: '/connections/nao-existe/posts' });
    expect(sync.statusCode).toBe(404);
    expect(posts.statusCode).toBe(404);
  });
});
