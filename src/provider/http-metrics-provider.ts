import type { Clock } from '../clock';
import {
  ProviderError,
  type Connection,
  type MetricsProvider,
  type PostSnapshot,
  type PostsPage,
  type SyncWindow,
} from './metrics-provider';

export interface ProviderRequest {
  path: '/posts';
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class TransportTimeoutError extends Error {}

// O fio até o provedor. Rejeita com TransportTimeoutError quando estoura o prazo.
export interface ProviderTransport {
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

// Traduz a resposta HTTP do provedor para a interface MetricsProvider.
export class HttpMetricsProvider implements MetricsProvider {
  constructor(
    private readonly transport: ProviderTransport,
    private readonly clock: Clock,
  ) {}

  async fetchPosts(
    connection: Connection,
    window: SyncWindow,
    cursor: string | null,
  ): Promise<PostsPage> {
    const query: Record<string, string> = {
      platform: connection.platform,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
    if (cursor !== null) query.cursor = cursor;

    let response: ProviderResponse;
    try {
      response = await this.transport.send({
        path: '/posts',
        query,
        headers: { authorization: `Bearer ${connection.accessToken}` },
      });
    } catch (error) {
      if (error instanceof TransportTimeoutError) {
        throw new ProviderError('timeout', 'o provedor não respondeu a tempo');
      }
      throw error;
    }

    if (response.status === 429) {
      throw new ProviderError(
        'rate_limited',
        'o provedor respondeu 429',
        parseRetryAfter(response.headers['retry-after'], this.clock.now()),
      );
    }
    if (response.status >= 500) {
      throw new ProviderError('unavailable', `o provedor respondeu ${response.status}`);
    }
    if (response.status !== 200) {
      throw new ProviderError('rejected', `o provedor respondeu ${response.status}`);
    }
    return parsePage(response.body);
  }
}

// Retry-After vem em segundos ou como data HTTP (RFC 9110).
export function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Data HTTP sempre termina em GMT. Sem essa checagem o Date.parse aceita
  // textos como "-5" e devolve uma data qualquer.
  const date = trimmed.endsWith('GMT') ? Date.parse(trimmed) : NaN;
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

function parsePage(body: string): PostsPage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw invalid('corpo não é JSON');
  }
  if (!isRecord(json) || !Array.isArray(json.data)) throw invalid('falta a lista data');
  const nextCursor = json.next_cursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') throw invalid('next_cursor inválido');
  return { posts: json.data.map(parsePost), nextCursor };
}

function parsePost(item: unknown): PostSnapshot {
  if (!isRecord(item) || !isRecord(item.metrics)) throw invalid('post sem metrics');
  if (typeof item.id !== 'string' || item.id === '') throw invalid('post sem id');
  return {
    postId: item.id,
    publishedAt: parseDate(item.published_at, 'published_at'),
    measuredAt: parseDate(item.measured_at, 'measured_at'),
    views: parseCount(item.metrics.views, 'views'),
    likes: parseCount(item.metrics.likes, 'likes'),
    comments: parseCount(item.metrics.comments, 'comments'),
    shares: parseCount(item.metrics.shares, 'shares'),
  };
}

function parseDate(value: unknown, field: string): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw invalid(`${field} inválido`);
  return date;
}

function parseCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${field} inválido`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(detail: string): ProviderError {
  return new ProviderError('invalid_response', `resposta inválida do provedor: ${detail}`);
}
