import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Connection, Platform, PostSnapshot } from './provider/metrics-provider';

export interface StoredPost {
  postId: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  measuredAt: string;
  fetchedAt: string;
}

// Posição de um post na listagem, que é ordenada por (published_at, post_id).
export interface PostKey {
  publishedAt: string;
  postId: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    access_token TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS post_metrics (
    connection_id TEXT NOT NULL REFERENCES connections (id),
    post_id TEXT NOT NULL,
    published_at TEXT NOT NULL,
    views INTEGER NOT NULL,
    likes INTEGER NOT NULL,
    comments INTEGER NOT NULL,
    shares INTEGER NOT NULL,
    measured_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, post_id)
  );
  CREATE INDEX IF NOT EXISTS post_metrics_listing
    ON post_metrics (connection_id, published_at, post_id);
`;

// Uma linha por post. O snapshot que chega substitui os números (nunca soma)
// e só entra se não for mais velho que o gravado. As datas são ISO em UTC,
// então comparar o texto é comparar o instante.
const UPSERT_SNAPSHOT = `
  INSERT INTO post_metrics (
    connection_id, post_id, published_at,
    views, likes, comments, shares, measured_at, fetched_at
  )
  VALUES (
    @connectionId, @postId, @publishedAt,
    @views, @likes, @comments, @shares, @measuredAt, @fetchedAt
  )
  ON CONFLICT (connection_id, post_id) DO UPDATE SET
    published_at = excluded.published_at,
    views = excluded.views,
    likes = excluded.likes,
    comments = excluded.comments,
    shares = excluded.shares,
    measured_at = excluded.measured_at,
    fetched_at = excluded.fetched_at
  WHERE excluded.measured_at >= post_metrics.measured_at
`;

export class Store {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    // WAL deixa o commit de cada página mais barato quando o banco é um arquivo.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  createConnection(platform: Platform, accessToken: string): Connection {
    const connection = { id: randomUUID(), platform, accessToken };
    this.db
      .prepare('INSERT INTO connections (id, platform, access_token) VALUES (?, ?, ?)')
      .run(connection.id, platform, accessToken);
    return connection;
  }

  findConnection(id: string): Connection | undefined {
    return this.db
      .prepare('SELECT id, platform, access_token AS accessToken FROM connections WHERE id = ?')
      .get(id) as Connection | undefined;
  }

  // Grava a página numa transação e devolve quantos snapshots entraram.
  saveSnapshots(connectionId: string, snapshots: PostSnapshot[], fetchedAt: Date): number {
    const upsert = this.db.prepare(UPSERT_SNAPSHOT);
    const saveAll = this.db.transaction(() => {
      let saved = 0;
      for (const snapshot of snapshots) {
        saved += upsert.run({
          connectionId,
          postId: snapshot.postId,
          publishedAt: snapshot.publishedAt.toISOString(),
          views: snapshot.views,
          likes: snapshot.likes,
          comments: snapshot.comments,
          shares: snapshot.shares,
          measuredAt: snapshot.measuredAt.toISOString(),
          fetchedAt: fetchedAt.toISOString(),
        }).changes;
      }
      return saved;
    });
    return saveAll();
  }

  // Sem limit devolve todos. Com after, devolve só os posts depois daquela posição.
  listPosts(connectionId: string, page: { limit?: number; after?: PostKey } = {}): StoredPost[] {
    const select = `
      SELECT post_id AS postId, published_at AS publishedAt,
             views, likes, comments, shares,
             measured_at AS measuredAt, fetched_at AS fetchedAt
      FROM post_metrics
      WHERE connection_id = ?`;
    const order = 'ORDER BY published_at, post_id LIMIT ?';
    // No SQLite, LIMIT -1 é sem limite.
    const limit = page.limit ?? -1;

    if (!page.after) {
      return this.db.prepare(`${select} ${order}`).all(connectionId, limit) as StoredPost[];
    }
    return this.db
      .prepare(`${select} AND (published_at, post_id) > (?, ?) ${order}`)
      .all(connectionId, page.after.publishedAt, page.after.postId, limit) as StoredPost[];
  }

  close(): void {
    this.db.close();
  }
}
