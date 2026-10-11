import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock } from './clock';
import { PLATFORMS, type MetricsProvider, type Platform } from './provider/metrics-provider';
import type { PostKey, Store } from './store';
import { SyncService, type SyncConfig } from './sync-service';

export interface AppDeps {
  store: Store;
  provider: MetricsProvider;
  clock: Clock;
  config?: SyncConfig;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function encodeCursor({ publishedAt, postId }: PostKey): string {
  return Buffer.from(JSON.stringify([publishedAt, postId])).toString('base64url');
}

function decodeCursor(cursor: string): PostKey | undefined {
  try {
    const [publishedAt, postId]: unknown[] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof publishedAt === 'string' && typeof postId === 'string') return { publishedAt, postId };
  } catch {
    // cursor ilegível cai no undefined abaixo
  }
  return undefined;
}

export function buildApp({ store, provider, clock, config }: AppDeps): FastifyInstance {
  const app = Fastify();
  const syncService = new SyncService(provider, store, clock, config);

  app.post<{ Body: { platform: Platform; accessToken: string } }>(
    '/connections',
    {
      schema: {
        body: {
          type: 'object',
          required: ['platform', 'accessToken'],
          properties: {
            platform: { type: 'string', enum: [...PLATFORMS] },
            accessToken: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, platform } = store.createConnection(request.body.platform, request.body.accessToken);
      return reply.code(201).send({ id, platform });
    },
  );

  // Roda o sync dentro da requisição e devolve o resultado.
  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/connections/:id/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const connection = store.findConnection(request.params.id);
      if (!connection) return reply.code(404).send({ error: 'conexão não encontrada' });

      const window = { from: new Date(request.body.from), to: new Date(request.body.to) };
      if (window.from >= window.to) {
        return reply.code(400).send({ error: 'from precisa ser anterior a to' });
      }

      const result = await syncService.sync(connection, window);
      if (result.status === 'rate_limited') {
        if (result.retryAt) {
          const seconds = (Date.parse(result.retryAt) - Date.parse(result.finishedAt)) / 1000;
          reply.header('retry-after', Math.ceil(seconds));
        }
        return reply.code(503).send(result);
      }
      return reply.code(result.status === 'completed' ? 200 : 502).send(result);
    },
  );

  // nextCursor só vem na resposta quando existe próxima página.
  app.get<{ Params: { id: string }; Querystring: { limit: number; cursor?: string } }>(
    '/connections/:id/posts',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!store.findConnection(request.params.id)) {
        return reply.code(404).send({ error: 'conexão não encontrada' });
      }
      const { limit, cursor } = request.query;
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !after) return reply.code(400).send({ error: 'cursor inválido' });

      // Busca um a mais para saber se existe próxima página.
      const rows = store.listPosts(request.params.id, { limit: limit + 1, after });
      const posts = rows.slice(0, limit);
      const last = posts.at(-1);
      if (rows.length > limit && last) return { posts, nextCursor: encodeCursor(last) };
      return { posts };
    },
  );

  return app;
}
