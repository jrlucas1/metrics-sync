import type { Clock } from './clock';
import {
  ProviderError,
  type Connection,
  type MetricsProvider,
  type PostsPage,
  type ProviderErrorKind,
  type SyncWindow,
} from './provider/metrics-provider';
import type { Store } from './store';

export interface SyncConfig {
  // Teto de chamadas ao provedor para cada página, contando a primeira.
  maxAttempts: number;
  // Espera após timeout ou 5xx: começa em backoffBaseMs, dobra, para em backoffMaxMs.
  backoffBaseMs: number;
  backoffMaxMs: number;
  // Maior Retry-After que o sync aceita esperar.
  maxRetryAfterMs: number;
}

export const defaultSyncConfig: SyncConfig = {
  maxAttempts: 4,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export interface SyncResult {
  status: 'completed' | 'failed' | 'rate_limited';
  startedAt: string;
  finishedAt: string;
  providerCalls: number;
  postsReceived: number;
  // Snapshots que entraram no banco. Repetido conta de novo, snapshot velho não.
  postsSaved: number;
  error?: { kind: ProviderErrorKind; message: string };
  // Em rate_limited: a partir de quando o provedor aceita nova chamada.
  retryAt?: string;
}

const TRANSIENT: ProviderErrorKind[] = ['timeout', 'unavailable', 'rate_limited'];

// Erro que encerra o sync, já com o prazo do provedor quando houver.
class SyncStopped extends Error {
  constructor(
    readonly reason: ProviderError,
    readonly retryAt?: Date,
  ) {
    super(reason.message);
  }
}

export class SyncService {
  constructor(
    private readonly provider: MetricsProvider,
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly config: SyncConfig = defaultSyncConfig,
  ) {}

  async sync(connection: Connection, window: SyncWindow): Promise<SyncResult> {
    const result: SyncResult = {
      status: 'completed',
      startedAt: this.clock.now().toISOString(),
      finishedAt: '',
      providerCalls: 0,
      postsReceived: 0,
      postsSaved: 0,
    };

    try {
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await this.fetchPage(connection, window, cursor, result);
        // Cada página é gravada assim que chega: se o sync parar adiante, o que
        // já entrou fica, e repetir a janela não duplica nada.
        result.postsReceived += page.posts.length;
        result.postsSaved += this.store.saveSnapshots(connection.id, page.posts, this.clock.now());

        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) {
            throw new SyncStopped(
              new ProviderError('invalid_response', `o provedor repetiu o cursor ${cursor}`),
            );
          }
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
    } catch (error) {
      if (!(error instanceof SyncStopped)) throw error;
      result.status = error.reason.kind === 'rate_limited' ? 'rate_limited' : 'failed';
      result.error = { kind: error.reason.kind, message: error.reason.message };
      if (error.retryAt) result.retryAt = error.retryAt.toISOString();
    }

    result.finishedAt = this.clock.now().toISOString();
    return result;
  }

  private async fetchPage(
    connection: Connection,
    window: SyncWindow,
    cursor: string | null,
    result: SyncResult,
  ): Promise<PostsPage> {
    for (let attempt = 1; ; attempt++) {
      try {
        result.providerCalls++;
        return await this.provider.fetchPosts(connection, window, cursor);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (!TRANSIENT.includes(error.kind)) throw new SyncStopped(error);

        const waitMs = this.waitBeforeRetry(error, attempt);
        const retryAt =
          error.kind === 'rate_limited'
            ? new Date(this.clock.now().getTime() + waitMs)
            : undefined;
        if (attempt >= this.config.maxAttempts) throw new SyncStopped(error, retryAt);
        // Prazo maior que o teto: esperar menos só gastaria uma tentativa em
        // outro 429, então o sync para e devolve o prazo.
        if (error.kind === 'rate_limited' && waitMs > this.config.maxRetryAfterMs) {
          throw new SyncStopped(error, retryAt);
        }
        await this.clock.sleep(waitMs);
      }
    }
  }

  private waitBeforeRetry(error: ProviderError, attempt: number): number {
    // 429 com Retry-After: o prazo é o do provedor, sem arredondar.
    if (error.kind === 'rate_limited' && error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }
    return Math.min(this.config.backoffBaseMs * 2 ** (attempt - 1), this.config.backoffMaxMs);
  }
}
