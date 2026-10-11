import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { FakePost } from '../src/provider/fake-transport';
import { post, setup } from './helpers';

const WIDE = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };

let app: FastifyInstance;
afterEach(() => app.close());

async function sync(id: string) {
  const response = await app.inject({ method: 'POST', url: `/connections/${id}/sync`, payload: WIDE });
  expect(response.statusCode).toBe(200);
}

// Sobe a API e sincroniza os posts dados numa conexão nova.
async function seed(posts: FakePost[]) {
  const context = setup(posts);
  app = buildApp(context);
  await sync(context.connection.id);
  return { ...context, id: context.connection.id };
}

async function page(id: string, query: string) {
  const response = await app.inject({ method: 'GET', url: `/connections/${id}/posts${query}` });
  const body = response.json() as { posts?: { postId: string }[]; nextCursor?: string };
  return {
    status: response.statusCode,
    ids: body.posts?.map((p) => p.postId),
    nextCursor: body.nextCursor,
    hasCursorField: 'nextCursor' in body,
  };
}

// Posts p000, p001, ... publicados de hora em hora.
function hourly(count: number): FakePost[] {
  return Array.from({ length: count }, (_, i) =>
    post(`p${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString()),
  );
}

describe('paginação da listagem', () => {
  it('percorre todas as páginas sem repetir nem pular post', async () => {
    const { id } = await seed(hourly(5));

    const first = await page(id, '?limit=2');
    const second = await page(id, `?limit=2&cursor=${first.nextCursor}`);
    const third = await page(id, `?limit=2&cursor=${second.nextCursor}`);

    expect(first.ids).toEqual(['p000', 'p001']);
    expect(second.ids).toEqual(['p002', 'p003']);
    expect(third.ids).toEqual(['p004']);
    expect(third.hasCursorField).toBe(false);
  });

  it('última página cheia não devolve cursor', async () => {
    const { id } = await seed(hourly(4));

    const first = await page(id, '?limit=2');
    const second = await page(id, `?limit=2&cursor=${first.nextCursor}`);

    expect(second.ids).toEqual(['p002', 'p003']);
    expect(second.hasCursorField).toBe(false);
  });

  it('empate de published_at na virada da página desempata pelo id', async () => {
    const same = '2026-10-02T10:00:00Z';
    const { id } = await seed([post('c', same), post('a', same), post('b', same)]);

    const first = await page(id, '?limit=2');
    const second = await page(id, `?limit=2&cursor=${first.nextCursor}`);

    expect(first.ids).toEqual(['a', 'b']);
    expect(second.ids).toEqual(['c']);
  });

  it('post que entra entre uma página e outra não faz repetir', async () => {
    const { id, transport } = await seed(hourly(4));
    const first = await page(id, '?limit=2');

    transport.setPosts([post('antigo', '2026-09-01T00:00:00Z')]);
    await sync(id);
    const second = await page(id, `?limit=2&cursor=${first.nextCursor}`);

    expect(second.ids).toEqual(['p002', 'p003']);
  });

  it('não mistura posts de outra conexão', async () => {
    const { id, store } = await seed(hourly(3));
    const other = store.createConnection('x', 'outro-token');
    await sync(other.id);

    const first = await page(id, '?limit=2');
    const second = await page(id, `?limit=2&cursor=${first.nextCursor}`);

    expect([...first.ids!, ...second.ids!]).toEqual(['p000', 'p001', 'p002']);
  });

  it('sem limit devolve 50 por página', async () => {
    const { id } = await seed(hourly(60));

    const first = await page(id, '');
    const second = await page(id, `?cursor=${first.nextCursor}`);

    expect(first.ids).toHaveLength(50);
    expect(second.ids).toHaveLength(10);
    expect(second.hasCursorField).toBe(false);
  });

  it('conexão sem posts devolve lista vazia sem cursor', async () => {
    const { id } = await seed([]);

    expect(await page(id, '')).toMatchObject({ status: 200, ids: [], hasCursorField: false });
  });

  it('aceita o limit máximo de 200', async () => {
    const { id } = await seed(hourly(3));

    expect((await page(id, '?limit=200')).status).toBe(200);
  });

  it.each(['?limit=0', '?limit=201', '?limit=-1', '?limit=abc', '?limit=1.5'])(
    'recusa %s',
    async (query) => {
      const { id } = await seed(hourly(3));

      expect((await page(id, query)).status).toBe(400);
    },
  );

  // 'e30' é {} e 'WzEsMl0' é [1,2] em base64url.
  it.each(['lixo', 'e30', 'WzEsMl0', ''])('recusa o cursor inválido "%s"', async (cursor) => {
    const { id } = await seed(hourly(3));

    expect((await page(id, `?limit=2&cursor=${cursor}`)).status).toBe(400);
  });
});
