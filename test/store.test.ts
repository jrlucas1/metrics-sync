import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('banco em arquivo', () => {
  it('abre em modo WAL e mantém os dados ao reabrir', () => {
    dir = mkdtempSync(join(tmpdir(), 'metrics-sync-'));
    const path = join(dir, 'metrics.db');

    const store = new Store(path);
    const connection = store.createConnection('youtube', 'token-de-teste');
    store.saveSnapshots(
      connection.id,
      [
        {
          postId: 'a',
          publishedAt: new Date('2026-10-02T10:00:00Z'),
          measuredAt: new Date('2026-10-10T08:00:00Z'),
          views: 100,
          likes: 10,
          comments: 1,
          shares: 0,
        },
      ],
      new Date('2026-10-11T12:00:00Z'),
    );
    store.close();

    const raw = new Database(path, { readonly: true });
    expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
    raw.close();

    const reopened = new Store(path);
    expect(reopened.listPosts(connection.id)).toEqual([
      expect.objectContaining({ postId: 'a', views: 100 }),
    ]);
    reopened.close();
  });
});
