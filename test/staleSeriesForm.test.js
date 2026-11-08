import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Settings } from 'luxon';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';

const id = 'source-refreshed-series';
const original = {
  id, title: 'Series with a refreshed source', service: 'Disney+', scheduleMode: 'livechart',
  scheduleLink: 'https://www.livechart.me/anime/11469/schedules', liveChartLanguageStrict: true,
  status: 'planned', enabled: true, weekly: true, nextEpisode: 6, episodeCount: null,
  nextDate: '', releaseDay: '', releaseTime: '', note: 'Original note', imageUrl: '',
  lastPostedKey: `${id}:main:5:release-time:2026-11-02T13:55:00.000+01:00`,
  lastPostedAt: '2026-11-02T13:55:10+01:00',
  languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 9,
    nextDate: '', releaseDay: '', releaseTime: '', weekly: true,
    lastPostedKey: `${id}:language:de:8:release-time:2026-10-17T16:30:00.000+02:00`,
    lastPostedAt: '2026-10-17T16:30:13+02:00' }]
};

function formData(html) {
  const $ = load(html);
  const body = new URLSearchParams();
  $('#series-form input, #series-form select, #series-form textarea').each((_, element) => {
    const input = $(element), name = input.attr('name');
    if (!name || (input.attr('type') === 'checkbox' && !input.is(':checked'))) return;
    body.append(name, input.attr('type') === 'checkbox' ? 'on' : input.val() || '');
  });
  assert.ok(body.get('seriesFormBaseline'), 'Existing forms must carry their original values');
  assert.deepEqual(JSON.parse(body.get('seriesFormChangedFields')), []);
  return body;
}

async function setup(t, overrides = {}) {
  const originalNow = Settings.now;
  Settings.now = () => Date.parse('2026-11-08T15:35:00+01:00');
  t.after(() => { Settings.now = originalNow; });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-stale-series-form-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), timeZone: 'Europe/Berlin' });
  await store.upsertSeries({ ...original, ...overrides });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) {
    messages.push(message.embeds[0].toJSON());
    return { sent: [{ channelId: '111111111111111111' }], failed: [] };
  } };
  let syncTask, syncPatch;
  const sync = { status: () => ({ running: false }), start({ seriesId, patch }) {
    syncPatch = structuredClone(patch);
    syncTask = store.upsertSeries({ ...store.getSeries(seriesId), ...patch }, { source: 'fake-pre-sync-save' });
    return syncTask;
  }, wait: () => syncTask };
  const server = createWebApp(store, discord, process.cwd(), { liveChartSync: sync }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = process.env.WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(
    `${process.env.WEB_USER || 'admin'}:${process.env.WEB_PASSWORD}`).toString('base64')}` } : {};
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    assert.ok(String(input).startsWith(`${base}/`), 'Only the isolated web server may be accessed');
    return fetchLocal(input, options);
  });
  const getForm = async () => {
    const response = await fetch(`${base}/series/${id}`, { headers });
    assert.equal(response.status, 200);
    return formData(await response.text());
  };
  const post = (body, suffix = '') => fetch(`${base}/series/${id}${suffix}`, {
    method: 'POST', redirect: 'manual', headers, body
  });
  const restoreSource = async () => {
    const current = store.getSeries(id);
    return store.upsertSeries({ ...current, status: 'airing', nextEpisode: 6, episodeCount: 12,
      nextDate: '2026-11-10', releaseDay: 'tuesday', releaseTime: '13:55',
      imageUrl: 'https://example.com/refreshed-cover.jpg', lastLiveChartCheckedAt: '2026-11-08T15:34:00+01:00',
      languageTracks: current.languageTracks.map(track => track.code === 'de' ? { ...track,
        nextEpisode: 9, nextDate: '2026-11-23', releaseDay: 'monday', releaseTime: '17:30', source: 'livechart' } : track)
    }, { source: 'fake-livechart-sync' });
  };
  return { store, messages, getForm, post, restoreSource, sync, syncPatch: () => syncPatch };
}

function assertFreshSchedule(actual, fresh) {
  for (const field of ['nextDate', 'releaseDay', 'releaseTime', 'nextEpisode', 'episodeCount', 'imageUrl',
    'lastPostedKey', 'lastPostedAt', 'lastLiveChartCheckedAt']) assert.equal(actual[field], fresh[field], field);
  assert.deepEqual(actual.languageTracks, fresh.languageTracks);
}

test('an invalid or mismatched form snapshot is rejected without saving or sending', async t => {
  const { store, messages, getForm, post } = await setup(t);
  const originalBody = await getForm();
  const snapshot = JSON.parse(originalBody.get('seriesFormBaseline'));
  const before = structuredClone(store.snapshot());
  for (const value of ['{', JSON.stringify({ ...snapshot, id: 'another-series' }),
    JSON.stringify({ ...snapshot, languageTracks: [null] })]) {
    const body = new URLSearchParams(originalBody);
    body.set('seriesFormBaseline', value);
    body.set('note', 'Must not save');
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Reload this entry before saving/);
    assert.deepEqual(store.snapshot(), before);
  }
  assert.equal(messages.length, 0);
});

test('saving a note from an old blank form preserves restored main and dub dates and source status', async t => {
  const { store, messages, getForm, post, restoreSource } = await setup(t);
  const body = await getForm();
  const fresh = await restoreSource();
  body.set('note', 'My new note');
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  assert.equal(saved.note, 'My new note');
  assert.equal(saved.status, 'airing');
  assertFreshSchedule(saved, fresh);
  assert.equal(messages.length, 0);
});

test('an intentional status edit from a stale form applies without undoing the latest source schedule', async t => {
  const { store, getForm, post, restoreSource } = await setup(t);
  const body = await getForm();
  const fresh = await restoreSource();
  body.set('status', 'unknown');
  assert.equal((await post(body)).status, 302);
  assert.equal(store.getSeries(id).status, 'unknown');
  assertFreshSchedule(store.getSeries(id), fresh);
});

test('explicitly clearing previously populated main and dub fields still clears them after another source update', async t => {
  const { store, getForm, post, restoreSource } = await setup(t);
  await restoreSource();
  const body = await getForm();
  const before = store.getSeries(id);
  const refreshed = await store.upsertSeries({ ...before, nextDate: '2026-11-11', releaseDay: 'wednesday',
    releaseTime: '14:05', languageTracks: before.languageTracks.map(track => track.code === 'de' ? {
      ...track, nextDate: '2026-11-24', releaseDay: 'tuesday', releaseTime: '18:10'
    } : track) });
  for (const field of ['nextDate', 'releaseDay', 'releaseTime', 'languageNextDate_de', 'languageReleaseDay_de',
    'languageReleaseTime_de']) body.set(field, '');
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  for (const field of ['nextDate', 'releaseDay', 'releaseTime']) assert.equal(saved[field], '');
  const dub = saved.languageTracks.find(track => track.code === 'de');
  for (const field of ['nextDate', 'releaseDay', 'releaseTime']) assert.equal(dub[field], '');
  assert.equal(dub.nextEpisode, 9);
  assert.equal(dub.lastPostedKey, refreshed.languageTracks.find(track => track.code === 'de').lastPostedKey);
});

test('an explicit pause clears newly restored dates even when those controls were blank when opened', async t => {
  const { store, getForm, post, restoreSource } = await setup(t);
  const body = await getForm();
  const fresh = await restoreSource();
  body.set('scheduleMode', 'manual');
  body.delete('weekly');
  for (const field of ['nextDate', 'releaseDay', 'releaseTime']) body.set(field, '');
  body.set('seriesFormChangedFields', JSON.stringify(['scheduleMode', 'weekly', 'nextDate', 'releaseDay', 'releaseTime']));
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  assert.equal(saved.scheduleMode, 'manual');
  assert.equal(saved.weekly, false);
  assert.equal(saved.status, 'airing');
  for (const field of ['nextDate', 'releaseDay', 'releaseTime']) assert.equal(saved[field], '');
  assert.equal(saved.nextEpisode, fresh.nextEpisode);
  assert.deepEqual(saved.languageTracks, fresh.languageTracks);
});

test('legacy submissions without a baseline retain their existing editable-form behavior', async t => {
  const { store, getForm, post } = await setup(t);
  const body = await getForm();
  body.delete('seriesFormBaseline');
  body.delete('seriesFormChangedFields');
  body.set('note', 'Legacy edit');
  body.set('nextDate', '2026-11-12');
  body.set('releaseDay', 'thursday');
  body.set('releaseTime', '18:00');
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  assert.equal(saved.note, 'Legacy edit');
  assert.equal(saved.nextDate, '2026-11-12');
  assert.equal(saved.releaseDay, 'thursday');
  assert.equal(saved.releaseTime, '18:00');
});

test('test posts from a stale form preserve and announce the current source date through fake Discord', async t => {
  const { store, messages, getForm, post, restoreSource } = await setup(t);
  const body = await getForm();
  const fresh = await restoreSource();
  const response = await post(body, '/test-post');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /Test%20post%20sent/);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /Episode 06/);
  assert.match(JSON.stringify(messages[0]), /10 Nov 2026/);
  assertFreshSchedule(store.getSeries(id), fresh);
  assert.equal(store.getSeries(id).status, 'airing');
});

test('the single-series sync receives only the intended stale-form edits before its source refresh', async t => {
  const { store, messages, getForm, post, restoreSource, sync, syncPatch } = await setup(t);
  const body = await getForm();
  const fresh = await restoreSource();
  body.set('note', 'Note before sync');
  assert.equal((await post(body, '/sync-livechart')).status, 302);
  await sync.wait();
  assert.equal(syncPatch().note, 'Note before sync');
  assert.equal(store.getSeries(id).note, 'Note before sync');
  assert.equal(store.getSeries(id).status, 'airing');
  assertFreshSchedule(store.getSeries(id), fresh);
  assert.equal(messages.length, 0);
});

test('enabling an unavailable placeholder language preserves its false availability and creates no late introduction', async t => {
  const { store, messages, getForm, post } = await setup(t, { languageTracks: [] });
  const body = await getForm();
  assert.equal(body.get('languageAvailable_de'), '0');
  assert.equal(store.getSeries(id).languageTracks.length, 0);
  body.set('languageEnabled_de', 'on');
  body.set('languageEpisode_de', '2');
  body.set('languageNextDate_de', '2026-11-23');
  body.set('languageReleaseDay_de', 'monday');
  body.set('languageReleaseTime_de', '17:30');
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  const dub = saved.languageTracks.find(track => track.code === 'de');
  assert.equal(dub.enabled, true);
  assert.equal(dub.available, false);
  assert.equal(dub.nextEpisode, 2);
  assert.equal(dub.nextDate, '2026-11-23');
  assert.equal(dub.releaseTime, '17:30');
  assert.deepEqual(saved.lateDubNotices, []);
  assert.equal(messages.length, 0);
});

test('an old unavailable placeholder cannot clear a newly discovered language availability', async t => {
  const { store, messages, getForm, post } = await setup(t, { languageTracks: [] });
  const body = await getForm();
  assert.equal(body.get('languageAvailable_de'), '0');
  const current = store.getSeries(id);
  const refreshed = await store.upsertSeries({ ...current, languageTracks: [{ code: 'de',
    enabled: true, available: true, nextEpisode: 9, nextDate: '2026-11-23', releaseDay: 'monday',
    releaseTime: '17:30', source: 'livechart',
    lastPostedKey: original.languageTracks[0].lastPostedKey,
    lastPostedAt: original.languageTracks[0].lastPostedAt }] }, { source: 'fake-livechart-sync' });
  body.set('note', 'An unrelated edit from the old form');
  assert.equal((await post(body)).status, 302);
  const saved = store.getSeries(id);
  assert.deepEqual(saved.languageTracks, refreshed.languageTracks);
  assert.equal(saved.languageTracks.find(track => track.code === 'de').available, true);
  assert.equal(saved.note, 'An unrelated edit from the old form');
  assert.equal(messages.length, 0);
});
