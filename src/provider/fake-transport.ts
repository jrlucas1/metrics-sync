import {
  TransportTimeoutError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTransport,
} from './http-metrics-provider';

export interface FakePost {
  id: string;
  publishedAt: string;
  measuredAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

// 'ok' deixa a chamada passar e ser respondida com os posts cadastrados.
export type ScriptedResponse = ProviderResponse | 'timeout' | 'ok';

// Provedor simulado. Responde no formato HTTP de um provedor de verdade e
// aceita um roteiro de respostas para simular timeout, 429 e erro.
export class FakeProviderTransport implements ProviderTransport {
  readonly requests: ProviderRequest[] = [];
  private script: ScriptedResponse[] = [];

  constructor(
    private posts: FakePost[] = [],
    private readonly pageSize = 2,
  ) {}

  setPosts(posts: FakePost[]): void {
    this.posts = posts;
  }

  // As próximas chamadas consomem o roteiro, na ordem, antes de voltar ao normal.
  respondNextWith(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const scripted = this.script.shift();
    if (scripted === 'timeout') throw new TransportTimeoutError();
    if (scripted !== undefined && scripted !== 'ok') return scripted;
    return this.page(request);
  }

  private page(request: ProviderRequest): ProviderResponse {
    const from = Date.parse(request.query.from ?? '');
    const to = Date.parse(request.query.to ?? '');
    const offset = Number(request.query.cursor ?? '0');
    if (Number.isNaN(from) || Number.isNaN(to) || !Number.isInteger(offset) || offset < 0) {
      return { status: 400, headers: {}, body: '{"error":"bad_request"}' };
    }

    const inWindow = this.posts.filter((post) => {
      const publishedAt = Date.parse(post.publishedAt);
      return publishedAt >= from && publishedAt < to;
    });
    const next = offset + this.pageSize;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: inWindow.slice(offset, next).map((post) => ({
          id: post.id,
          published_at: post.publishedAt,
          measured_at: post.measuredAt,
          metrics: {
            views: post.views,
            likes: post.likes,
            comments: post.comments,
            shares: post.shares,
          },
        })),
        next_cursor: next < inWindow.length ? String(next) : null,
      }),
    };
  }
}
