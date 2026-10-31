import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { hasUpcomingGermanRelease, selectScheduleRows } from '../src/livechartCatalog.js';
import { createDiscoveryController } from '../src/livechartDiscovery.js';
import { createStore } from '../src/store.js';

const now = DateTime.fromISO('2026-10-31T16:12:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const options = { preferredLanguageCodes: ['de'], requirePreferredLanguage: true,
  nowTimestamp: now.toSeconds(), timeZone: settings.timeZone };

function row(type, { id = '1', label = 'EP5', heading = '', german = false, region = false } = {}) {
  return `<article data-controller="release-schedule"><a href="/anime/123/schedules/${id}"></a>
    <div>${heading || `<time data-timestamp="1793545200" data-label="${label}">${label}</time>`}
    ${region ? 'This schedule might not apply to your region.' : ''}</div>
    <div title="${type}">${type}</div><span class="lc-text-contextual-accent">Crunchyroll</span>
    <span data-release-schedule-info-target="auralTracklist" data-tracklist-data='{"ja":[["JA"],["Japanese"]]}'>JA</span>
    ${german ? '<span data-release-schedule-info-target="textualTracklist" data-tracklist-data=\'{"de":[["DE"],["German"]]}\'>DE</span>' : ''}</article>`;
}

test('known local categories do not block a German streaming schedule', () => {
  for (const type of ['Streaming', 'Streaming (Japan)', 'Streaming (China)', 'Streaming (Japan): Preview',
    'Streaming (Japan): Uncensored', 'Theaters (Japan)', 'Digital Rental (Japan)', 'Blu-ray (Japan)', 'DVD (Japan)']) {
    for (const region of [true, false]) {
      const html = row(type, { region }) + row('Simulcast: Subbed', { id: '2', german: true });
      const rows = selectScheduleRows(html);
      assert.equal(rows[0].isOtherSchedule, true, type);
      assert.equal(hasUpcomingGermanRelease(html, settings, now), true, type);
      const live = parseLiveChartEpisodes(html, options);
      assert.equal(live.nextEpisode, 5, type);
      assert.equal(live.mainReleaseTimestamp, 1793545200, type);
    }
  }
});

test('a valid cinema-only or regional page is skipped without a format error or invented German release', () => {
  for (const type of ['Theaters (Japan)', 'Streaming (Japan): Uncensored', 'Streaming (China)']) {
    const html = row(type, { region: true });
    assert.equal(selectScheduleRows(html).length, 1);
    assert.equal(hasUpcomingGermanRelease(html, settings, now), false);
    const live = parseLiveChartEpisodes(html, options);
    assert.equal(live.nextEpisode, null);
    assert.deepEqual(live.languageTracks, []);
  }
});

test('an ended preview is terminal and never interpreted as an upcoming numbered release', () => {
  const html = row('Simulcast: Preview, Subbed', { heading: 'Release ended with EP6', german: true });
  assert.equal(selectScheduleRows(html)[0].isReleased, true);
  assert.equal(hasUpcomingGermanRelease(html, settings, now), false);
  const live = parseLiveChartEpisodes(html, options);
  assert.equal(live.mainFinished, true);
  assert.equal(live.nextEpisode, null);
});

test('unknown categories and unrelated streaming news still fail closed', () => {
  assert.throws(() => selectScheduleRows(row('Unrecognized future category')), /format could not be read/);
  assert.throws(() => selectScheduleRows('<article><a title="Streaming">Streaming news</a></article>'), /No LiveChart schedules/);
});

test('discovery imports a German title despite unrelated local distribution rows', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-category-discovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings, liveChartDiscoverySeason: 'fall-2026' });
  const html = row('Theaters (Japan)', { region: true }) +
    row('Streaming (Japan)', { id: '3' }) + row('Simulcast: Subbed', { id: '2', german: true });
  const discovery = createDiscoveryController(store, { now: () => now, fetchHtml: async (url) => {
    if (url.endsWith('/all')) return '<article data-anime-id="123" data-anime-item-english-title="German title"><div class="lc-anime-details-card__metadata">12 eps</div></article>';
    return url.endsWith('/schedules') ? html : '<h1>German title</h1>';
  } });
  const result = await discovery.start();
  assert.equal(result.failed, 0);
  assert.equal(result.added, 1);
  assert.equal(discovery.status().error, '');
  assert.equal(store.listSeries()[0].nextEpisode, 5);
  assert.equal(store.listSeries()[0].nextDate, '2026-11-01');
});
