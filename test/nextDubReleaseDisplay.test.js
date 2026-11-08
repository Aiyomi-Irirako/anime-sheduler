import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Settings } from 'luxon';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';

const dub = (overrides = {}) => ({ code: 'de', enabled: true, available: true, nextEpisode: 9,
  nextDate: '2026-11-23', releaseTime: '17:30', releaseDay: '', weekly: true, ...overrides });
const bleach = (overrides = {}) => ({ id: 'bleach-pending-dub', title: 'BLEACH: Thousand-Year Blood War',
  service: 'Disney+', status: 'finished', enabled: true, nextEpisode: null, nextDate: '',
  releaseDay: 'monday', releaseTime: '16:30', episodeCount: 10,
  languageTracks: [dub()], ...overrides });

async function setup(t, series) {
  const originalNow = Settings.now;
  Settings.now = () => Date.parse('2026-11-08T15:35:00+01:00');
  t.after(() => { Settings.now = originalNow; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-next-dub-display-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), timeZone: 'Europe/Berlin', lookaheadDays: 14 });
  const saved = await store.upsertSeries(series);
  const before = structuredClone(store.snapshot());
  const app = createWebApp(store, { enabled: false, async post() { throw new Error('No Discord posts expected'); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = process.env.WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(
    `${process.env.WEB_USER || 'admin'}:${process.env.WEB_PASSWORD}`).toString('base64')}` } : {};
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    assert.ok(String(input).startsWith(`${base}/`), 'Only the isolated local server may be accessed');
    return fetchLocal(input, options);
  });
  const get = async route => {
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200);
    return load(await response.text());
  };
  const editor = await get(`/series/${saved.id}`);
  const dashboard = await get('/');
  const row = dashboard('#seriesTable tbody tr').filter((_, element) =>
    dashboard(element).find('a.title-link').attr('href') === `/series/${saved.id}`).first();
  assert.equal(row.length, 1);
  const cells = row.find('td');
  return { editor, dashboard, cells, header: editor('h1').closest('.section-title').find('p').first().text(),
    noChanges: () => assert.deepEqual(store.snapshot(), before) };
}

test('a finished original displays its saved German episode 9 date and time in the editor and table', async t => {
  const { editor, cells, header, noChanges } = await setup(t, bleach());
  assert.equal(header, 'Next release: Monday, 23 Nov 2026 17:30');
  assert.equal(cells.eq(2).find('small').text(), '17:30');
  assert.match(cells.eq(2).text(), /^Monday/);
  assert.equal(cells.eq(3).text(), '2026-11-23');
  assert.match(cells.eq(4).text(), /Episode 09\/10 \(German\)/);
  assert.equal(cells.eq(5).text(), '23 Nov 2026 17:30');
  // The display must not copy dub values into the original's editable fields.
  assert.equal(editor('input[name="releaseTime"]').val(), '16:30');
  assert.equal(editor('input[name="languageReleaseTime_de"]').val(), '17:30');
  assert.equal(editor('input[name="nextDate"]').val(), '');
  noChanges();
});

for (const [label, nextDate] of [['later', '2026-11-25'], ['stale', '2026-11-01']]) {
  test(`a current German dub supplies every table field instead of a ${label} original`, async t => {
    const { cells, header, noChanges } = await setup(t, bleach({ status: 'airing', nextEpisode: 10,
      nextDate, releaseDay: 'wednesday', releaseTime: '07:00' }));
    assert.equal(header, 'Next release: Monday, 23 Nov 2026 17:30');
    assert.match(cells.eq(2).text(), /^Monday/);
    assert.equal(cells.eq(2).find('small').text(), '17:30');
    assert.equal(cells.eq(3).text(), '2026-11-23');
    assert.match(cells.eq(4).text(), /German/);
    assert.equal(cells.eq(5).text(), '23 Nov 2026 17:30');
    noChanges();
  });
}

test('simultaneous original and dub dates display both episode entries with their shared posting time', async t => {
  const { cells, header, noChanges } = await setup(t, bleach({ status: 'airing', nextEpisode: 10,
    nextDate: '2026-11-23', releaseDay: 'saturday', releaseTime: '17:30' }));
  assert.equal(header, 'Next release: Monday, 23 Nov 2026 17:30');
  assert.match(cells.eq(4).text(), /Episode 10\/10/);
  assert.match(cells.eq(4).text(), /Episode 09\/10 \(German\)/);
  assert.equal(cells.eq(2).find('small').text(), '17:30');
  assert.equal(cells.eq(3).text(), '2026-11-23');
  noChanges();
});

test('a dated dub without a time is displayed as missing time instead of borrowing the original time', async t => {
  const { dashboard, cells, header, noChanges } = await setup(t, bleach({ languageTracks: [dub({ releaseTime: '' })] }));
  assert.equal(header, 'Next release: Monday, 23 Nov 2026 - time missing');
  assert.equal(cells.eq(2).find('small').text(), 'time missing');
  assert.equal(cells.eq(3).text(), '2026-11-23');
  assert.equal(cells.eq(5).text(), '23 Nov 2026 - time missing');
  const missingTimeStat = dashboard('.stats > div').filter((_, element) =>
    dashboard(element).find('small').text() === 'Missing time');
  assert.equal(missingTimeStat.find('span').text(), '1');
  noChanges();
});

test('an undated pending dub does not fabricate a date or borrow a stale original pattern', async t => {
  const { cells, header, noChanges } = await setup(t, bleach({ languageTracks: [dub({ nextDate: '', releaseTime: '' })] }));
  assert.equal(header, 'Next release: No release date');
  assert.equal(cells.eq(2).find('small').text(), '-');
  assert.equal(cells.eq(3).text(), '-');
  assert.equal(cells.eq(5).text(), 'No release date');
  noChanges();
});

test('an original-only schedule retains its own date, time and episode display', async t => {
  const { cells, header, noChanges } = await setup(t, bleach({ status: 'airing', nextEpisode: 2,
    nextDate: '2026-11-10', releaseDay: 'tuesday', releaseTime: '19:15', languageTracks: [] }));
  assert.equal(header, 'Next release: Tuesday, 10 Nov 2026 19:15');
  assert.equal(cells.eq(2).find('small').text(), '19:15');
  assert.equal(cells.eq(3).text(), '2026-11-10');
  assert.equal(cells.eq(4).text(), 'Episode 02/10');
  assert.equal(cells.eq(5).text(), '10 Nov 2026 19:15');
  noChanges();
});
