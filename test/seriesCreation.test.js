import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';
import { findDuplicateSeries } from '../src/seriesIdentity.js';
import { liveChartId } from '../src/livechartHttp.js';
import { parseLiveChartTitle, fetchLiveChartTitle } from '../src/livechart.js';

const link = (id) => `https://www.livechart.me/anime/${id}/schedules`;
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-series-create-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createStore(path.join(dir, 'db.json'));
  await store.init();
  return store;
}

test('title reader decodes metadata and canonicalizes release-specific links', async () => {
  assert.equal(parseLiveChartTitle('<meta property="og:title" content="Title &amp; Friends Season 2">'), 'Title & Friends Season 2');
  assert.equal(parseLiveChartTitle('<title>Title - Release Schedules | LiveChart.me</title>'), 'Title');
  assert.equal(parseLiveChartTitle('<h1>Title</h1>'), 'Title');
  let requests = 0;
  const fetchHtml = async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://www.livechart.me/anime/123');
    assert.equal(options.ttlMs, 24 * 3600000);
    return '<meta property="og:title" content="Fetched title">';
  };
  assert.equal(await fetchLiveChartTitle('http://livechart.me/anime/00123/schedules/44?x=1#test', { fetchHtml }), 'Fetched title');
  for (const invalid of ['https://evil.invalid/anime/123', 'https://livechart.me.evil.invalid/anime/123', 'ftp://livechart.me/anime/123',
    'https://name@livechart.me/anime/123', 'https://livechart.me:8443/anime/123', 'https://livechart.me/anime/0']) {
    assert.equal(liveChartId(invalid), '');
    await assert.rejects(fetchLiveChartTitle(invalid, { fetchHtml }), /valid LiveChart/);
  }
  assert.equal(requests, 1);
  await assert.rejects(fetchLiveChartTitle(link('123'), { fetchHtml: async () => '<html></html>' }), /No series title/);
});

test('duplicate identity uses source IDs first, normalized titles otherwise, and preserves distinct seasons', () => {
  const entries = [{ id: 'a', title: 'Name', scheduleLink: link('1'), malId: '10' }, { id: 'b', title: 'Manual  Title' }];
  assert.equal(findDuplicateSeries(entries, { title: 'Alias', scheduleLink: 'http://livechart.me/anime/1/schedules/3?x=1' }).id, 'a');
  assert.equal(findDuplicateSeries(entries, { title: 'Alias', malId: 10 }).id, 'a');
  assert.equal(findDuplicateSeries(entries, { title: ' manual\nTITLE ', service: 'Different service' }).id, 'b');
  assert.equal(findDuplicateSeries(entries, { title: 'Name', scheduleLink: link('2'), malId: '11' }), null);
  assert.equal(findDuplicateSeries(entries, { title: 'Name Season 2' }), null);
  assert.equal(findDuplicateSeries(entries, entries[0], 'a'), null);
});

test('store rejects duplicate creation and identity edits without overwriting existing data', async (t) => {
  const store = await setup(t);
  const existing = await store.upsertSeries({ title: 'Original', scheduleLink: link('1'), streamingServiceId: 'KEEP' });
  const other = await store.upsertSeries({ title: 'Other', scheduleLink: link('2') });
  const before = store.snapshot();
  await assert.rejects(store.upsertSeries({ title: 'Alias', scheduleLink: 'https://livechart.me/anime/1' }), { code: 'DUPLICATE_SERIES', existingSeriesId: existing.id });
  await assert.rejects(store.upsertSeries({ title: ' original ' }), { code: 'DUPLICATE_SERIES' });
  await assert.rejects(store.upsertSeries({ ...other, scheduleLink: link('1') }), { code: 'DUPLICATE_SERIES' });
  await assert.rejects(store.replaceSeries(other.id, { ...other, scheduleLink: link('1') }), { code: 'DUPLICATE_SERIES' });
  assert.deepEqual(store.snapshot(), before);
  await store.upsertSeries({ ...existing, streamingServiceId: 'CHANGED' });
  assert.equal(store.listSeries().length, 2);
});

test('concurrent creates only insert a matching series once', async (t) => {
  const store = await setup(t);
  const results = await Promise.allSettled([store.upsertSeries({ title: 'One', scheduleLink: link('1') }),
    store.upsertSeries({ title: 'One alias', scheduleLink: 'https://livechart.me/anime/1/schedules/2' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(store.listSeries().length, 1);
  const reopened = createStore(store.filePath);
  await reopened.init();
  assert.equal(reopened.listSeries().length, 1);
});

test('legacy duplicates remain present and editable without creating more copies', async (t) => {
  const store = await setup(t);
  await store.replaceData({ series: [{ id: 'a', title: 'Old duplicate', scheduleLink: link('1') },
    { id: 'b', title: 'Old duplicate', scheduleLink: link('1') }] });
  await store.upsertSeries({ ...store.getSeries('a'), streamingServiceId: 'KEEP' });
  assert.equal(store.listSeries().length, 2);
  await assert.rejects(store.upsertSeries({ title: 'Alias', scheduleLink: link('1') }), { code: 'DUPLICATE_SERIES' });
});

test('CSV import deduplicates URL aliases, repeated rows, and exact manual titles', async (t) => {
  const store = await setup(t);
  await store.upsertSeries({ title: 'Original', scheduleLink: link('1'), streamingServiceId: 'KEEP' });
  await store.upsertSeries({ title: 'Manual Title' });
  const csv = 'title,service,schedulelink\nAlias,Crunchyroll,https://livechart.me/anime/1\nManual Title,Netflix,\nNew,Crunchyroll,https://livechart.me/anime/2\nNew alias,Netflix,https://www.livechart.me/anime/2/schedules/3';
  assert.deepEqual(await store.importCsv(csv), { total: 4, created: 1, updated: 0, skipped: 3 });
  assert.equal(store.listSeries().length, 3);
  assert.deepEqual(await store.importCsv(csv, { updateExisting: true }), { total: 4, created: 0, updated: 4, skipped: 0 });
  assert.equal(store.listSeries().find((series) => liveChartId(series.scheduleLink) === '1').streamingServiceId, 'KEEP');
});

test('manual creation fetches a missing title, preserves user text, and redirects duplicates to the existing entry', async (t) => {
  const store = await setup(t);
  let requests = 0;
  const fetchTitle = async (url) => {
    requests += 1;
    if (!liveChartId(url)) throw new Error('Enter a title or a valid LiveChart link.');
    if (liveChartId(url) === '99') throw new Error('LiveChart unavailable');
    return 'Fetched title';
  };
  const discord = { enabled: false, listTextChannels: async () => [], listMentionRoles: async () => [] };
  const app = createWebApp(store, discord, process.cwd(), { fetchTitle });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(body) });
  const form = load(await (await fetch(`${base}/series/new`)).text());
  assert.equal(form('input[name="scheduleLink"]').length, 1);
  assert.equal(form('input[name="title"]').attr('required'), undefined);
  const lookup = await post('/api/livechart/title', { scheduleLink: link('1') });
  assert.deepEqual(await lookup.json(), { title: 'Fetched title' });
  const created = await post('/series', { scheduleLink: link('1'), title: '', streamingServiceId: 'KEEP', enabled: 'on' });
  assert.equal(created.status, 302);
  const existing = store.listSeries()[0];
  assert.equal(existing.title, 'Fetched title');
  const count = requests;
  const duplicateLookup = await post('/api/livechart/title', { scheduleLink: 'https://livechart.me/anime/1/schedules/3' });
  assert.equal(duplicateLookup.status, 409);
  assert.equal((await duplicateLookup.json()).existingSeriesId, existing.id);
  const duplicate = await post('/series', { title: 'Changed', scheduleLink: 'https://livechart.me/anime/1' });
  assert.match(duplicate.headers.get('location'), new RegExp(`/series/${existing.id}`));
  assert.equal(requests, count);
  assert.equal(existing.streamingServiceId, 'KEEP');
  assert.equal(store.listSeries().length, 1);
  await post('/series', { title: 'Custom title', scheduleLink: link('2') });
  assert.equal(requests, count);
  const invalid = await post('/series', { title: '', note: 'Retain this input' });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /Retain this input/);
  const failed = await post('/series', { title: '', scheduleLink: link('99') });
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /LiveChart unavailable/);
  assert.equal(store.listSeries().length, 2);
});
