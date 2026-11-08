import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { createLiveChartSyncController } from '../src/livechartSync.js';

const now = DateTime.fromISO('2026-11-07T22:37:55', { zone: 'Europe/Berlin' });
const title = 'Even the Student Council Has Its Holes!';

for (const { description, result, message } of [
  {
    description: 'a skipped manual schedule is identified without claiming a source check succeeded',
    result: { changed: false, skipped: true, live: {} },
    message: 'Manual schedule kept'
  },
  {
    description: 'a missing matching subtitle source is reported even when stored fields were already empty',
    result: { changed: false, live: { mainUnavailable: true } },
    message: 'No matching subtitle schedule found for the selected language'
  },
  {
    description: 'a legitimate dub update retains its update count while the main subtitle source is missing',
    result: { changed: true, live: { mainUnavailable: true, languageTracks: [{ code: 'de', nextEpisode: 2 }] } },
    message: 'No matching subtitle schedule found for the selected language'
  },
  {
    description: 'an unspecified next episode is distinguished from an unchanged usable schedule',
    result: { changed: false, live: { mainEpisodeUnknown: true } },
    message: 'LiveChart has not specified the next episode yet'
  },
  {
    description: 'clearing an unspecified next episode retains the source explanation and update count',
    result: { changed: true, live: { mainEpisodeUnknown: true } },
    message: 'LiveChart has not specified the next episode yet'
  },
  {
    description: 'a usable changed schedule retains the existing successful update message',
    result: { changed: true, live: { nextEpisode: 7, mainUnavailable: false, mainEpisodeUnknown: false } },
    message: 'LiveChart updated'
  },
  {
    description: 'a usable unchanged schedule retains the existing no-change message',
    result: { changed: false, live: { nextEpisode: 7, mainUnavailable: false, mainEpisodeUnknown: false } },
    message: 'No changes found'
  }
]) {
  test(`single-series sync feedback: ${description}`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-sync-feedback-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createStore(path.join(directory, 'isolated-db.json'));
    await store.init();
    const series = await store.upsertSeries({ id: 'student-council', title,
      scheduleLink: 'https://www.livechart.me/anime/13150/schedules', enabled: true,
      scheduleMode: result.skipped ? 'manual' : 'livechart', nextEpisode: null,
      nextDate: '', releaseDay: '', releaseTime: '', liveChartImportLanguage: 'de' });
    const before = structuredClone(store.snapshot());
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
    let calls = 0;
    const controller = createLiveChartSyncController(store, { now: () => now,
      syncOne: async (target, saved, options) => {
        calls += 1;
        assert.equal(target, store);
        assert.equal(saved.id, series.id);
        assert.equal(options.overwriteSchedule, true);
        assert.equal(options.source, 'livechart-sync');
        assert.equal(options.now, now);
        return result;
      }
    });

    assert.equal(await controller.start({ seriesId: series.id }), result);
    const status = controller.status();
    assert.equal(calls, 1);
    assert.equal(status.progress, `${title}: ${message}`);
    assert.equal(status.checked, 1);
    assert.equal(status.total, 1);
    assert.equal(status.updated, result.changed ? 1 : 0);
    assert.equal(status.failed, 0);
    assert.equal(status.error, '');
    assert.equal(status.running, false);
    assert.equal(status.startedAt, now.toISO());
    assert.equal(status.finishedAt, now.toISO());
    assert.deepEqual(store.snapshot(), before);
  });
}
