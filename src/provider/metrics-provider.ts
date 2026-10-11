// Tudo o que a regra de negócio conhece de um provedor. O serviço de sync
// depende só deste arquivo; HTTP, headers e JSON ficam do outro lado.

export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Connection {
  id: string;
  platform: Platform;
  accessToken: string;
}

// Posts publicados em [from, to).
export interface SyncWindow {
  from: Date;
  to: Date;
}

// Contadores absolutos do post no instante measuredAt, não deltas.
export interface PostSnapshot {
  postId: string;
  publishedAt: Date;
  measuredAt: Date;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface PostsPage {
  posts: PostSnapshot[];
  nextCursor: string | null;
}

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'rejected'
  | 'invalid_response';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    // Só em rate_limited, quando o provedor mandou um Retry-After legível.
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface MetricsProvider {
  fetchPosts(
    connection: Connection,
    window: SyncWindow,
    cursor: string | null,
  ): Promise<PostsPage>;
}
