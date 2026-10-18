import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { latestHotRanking } from '@aihot/backend/publication/hot';

after(closeDb);

test('a cold read that finds nothing yet does not stick: later reads see the first published ranking', async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, enabled) VALUES
    ('editorial', 'Editorial', 'rss', 'editorial', true),
    ('signal', 'Signal', 'x_search', 'hot_signal', true),
    ('disabled', 'Disabled', 'rss', 'editorial', false)`;
  assert.equal(await latestHotRanking(), null);
  const [published] = await sql`INSERT INTO hot_rankings (computed_at, rule_version, entries, published)
    VALUES (now(), 'test', '[]', true) RETURNING id`;
  assert.equal((await latestHotRanking())?.id, published!.id);
});
