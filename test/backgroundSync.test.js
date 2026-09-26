import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';
import { createLiveChartSyncController, getLiveChartSyncController, startLiveChartDailySync, syncAllLiveChart } from '../src/livechartSync.js';

const summary = '2 checked, 1 updated, 0 deleted, 0 failed';
const result = { checked: 2, updated: 1, deleted: 0, failed: 0, errors: [], summary };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t, dependencies = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-background-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.upsertSeries({ id: 'test', title: 'Test series', scheduleLink: 'https://www.livechart.me/anime/123/schedules', enabled: true });
  const controller = createLiveChartSyncController(store, dependencies);
  const discord = { enabled: false, listTextChannels: async () => [], listMentionRoles: async () => [] };
  const app = createWebApp(store, discord, process.cwd(), { liveChartSync: controller });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}) => fetch(`${base}${route}`, {
    method: 'POST', body: new URLSearchParams(body), redirect: 'manual', signal: AbortSignal.timeout(1500)
  });
  return { store, controller, base, post };
}

for (const [route, body, target] of [
  ['/settings', { settingsAction: 'sync-livechart' }, '/settings#settings-livechart'],
  ['/sync-livechart-all', {}, '/settings#settings-livechart'],
  ['/sync-livechart-all', { returnTo: '/finished' }, '/finished']
]) {
  test(`a slow full sync returns immediately from ${route} to ${target}`, async (t) => {
    const gate = deferred();
    let calls = 0;
    const { controller, base, post } = await setup(t, { syncAll: async (_, { onProgress }) => {
      calls += 1;
      onProgress({ checked: 1, total: 2, updated: 1, deleted: 0, failed: 0, currentTitle: 'Pending series' });
      await gate.promise;
      return result;
    } });
    t.after(async () => { gate.resolve(); await controller.wait(); });
    const response = await post(route, body);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), target);
    const status = await fetch(`${base}/api/livechart/sync-status`);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const job = await status.json();
    assert.equal(job.running, true);
    assert.equal(job.total, 2);
    assert.match(job.progress, /1\/2: Pending series/);
    for (const page of ['/settings', '/finished', '/series/test']) {
      const $ = load(await (await fetch(base + page)).text());
      assert.equal($('[data-livechart-sync-status]').attr('data-running'), 'true');
      assert.equal($('[data-livechart-sync-button]').is(':disabled'), true);
    }
    const duplicate = await post('/sync-livechart-all');
    assert.match(decodeURIComponent(duplicate.headers.get('location')), /already running/);
    assert.equal(calls, 1);
    gate.resolve();
    await controller.wait();
    assert.equal(controller.status().running, false);
    assert.match(controller.status().progress, /2 checked, 1 updated/);
    assert.ok(controller.status().finishedAt);
  });
}

test('single-series sync saves form edits in the background and returns before LiveChart answers', async (t) => {
  const gate = deferred();
  let calls = 0;
  const { store, controller, base, post } = await setup(t, { syncOne: async (_, series, options) => {
    calls += 1;
    assert.equal(series.title, 'Edited title');
    assert.equal(options.overwriteSchedule, true);
    await gate.promise;
    return { changed: true };
  } });
  t.after(async () => { gate.resolve(); await controller.wait(); });
  const response = await post('/series/test/sync-livechart', { title: 'Edited title', scheduleLink: 'https://www.livechart.me/anime/123/schedules' });
  assert.equal(response.headers.get('location'), '/series/test');
  assert.equal((await (await fetch(`${base}/api/livechart/sync-status`)).json()).seriesId, 'test');
  const duplicate = await post('/series/test/sync-livechart', { title: 'Duplicate request' });
  assert.match(decodeURIComponent(duplicate.headers.get('location')), /already running/);
  assert.equal(store.getSeries('test').title, 'Edited title');
  gate.resolve();
  await controller.wait();
  assert.equal(calls, 1);
  assert.equal(controller.status().checked, 1);
  assert.equal(controller.status().updated, 1);
  assert.match(controller.status().progress, /LiveChart updated/);
});

test('background failures are visible, escaped, and release the running-job guard', async (t) => {
  const gate = deferred();
  let calls = 0;
  const { controller, base, post } = await setup(t, { syncAll: async () => {
    calls += 1;
    await gate.promise;
    throw new Error('HTTP 429 <script>alert(1)</script>');
  } });
  t.after(async () => { gate.resolve(); await controller.wait(); });
  assert.equal((await post('/sync-livechart-all')).status, 302);
  gate.resolve();
  assert.equal(await controller.wait(), null);
  assert.equal(controller.status().running, false);
  assert.match(controller.status().error, /HTTP 429/);
  const $ = load(await (await fetch(`${base}/settings`)).text());
  assert.match($('[data-sync-error]').text(), /<script>/);
  assert.equal($('[data-sync-error] script').length, 0);
  assert.equal($('[data-livechart-sync-button]').is(':disabled'), false);
  await controller.start();
  assert.equal(calls, 2);
});

test('partial failures retain counts and only bounded error details in the current status', async (t) => {
  const { store, controller } = await setup(t, { syncAll: async (_, { onProgress }) => {
    onProgress({ checked: 5, total: 5, updated: 0, deleted: 0, failed: 5, currentTitle: '' });
    return { ...result, summary: '5 checked, 0 updated, 0 deleted, 5 failed',
      errors: Array.from({ length: 5 }, (_, i) => ({ title: `Series ${i}`, message: 'Failed' })) };
  } });
  const before = store.snapshot();
  await controller.start();
  assert.equal(controller.status().failed, 5);
  assert.match(controller.status().error, /Series 2/);
  assert.doesNotMatch(controller.status().error, /Series 3/);
  assert.deepEqual(store.snapshot(), before);
});

test('daily and manual runs share the same guard without changing the once-daily timer', async (t) => {
  const gate = deferred();
  let timerTick;
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 60000);
    timerTick = callback;
    return 1;
  });
  let calls = 0;
  const { store, controller, post } = await setup(t, { syncAll: async (target) => {
    calls += 1;
    await gate.promise;
    await target.markLiveChartSync({ summary });
    return result;
  } });
  t.after(async () => { gate.resolve(); await controller.wait(); });
  assert.equal(getLiveChartSyncController(store), getLiveChartSyncController(store));
  await store.updateSettings({ ...store.getSettings(), liveChartSyncEnabled: true, liveChartSyncTime: '00:00' });
  startLiveChartDailySync(store, { controller });
  assert.equal(controller.status().running, true);
  await timerTick();
  const response = await post('/sync-livechart-all');
  assert.match(decodeURIComponent(response.headers.get('location')), /already running/);
  assert.equal(calls, 1);
  gate.resolve();
  await controller.wait();
  await timerTick();
  assert.equal(calls, 1);
  assert.equal(DateTime.fromISO(store.getSettings().lastLiveChartSyncAt).toISODate(), DateTime.now().toISODate());
});

test('bulk progress reports finished requests and stops at the existing rate-limit boundary', async (t) => {
  const { store } = await setup(t);
  for (const id of ['456', '789']) await store.upsertSeries({ title: `Series ${id}`, enabled: true, scheduleLink: `https://www.livechart.me/anime/${id}/schedules` });
  const progress = [];
  let calls = 0;
  const actual = await syncAllLiveChart(store, { delayMs: 0, onProgress: value => progress.push(value), fetchEpisodes: async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    return { nextEpisode: 1, episodeCount: 12, languageTracks: [] };
  } });
  assert.equal(progress[0].checked, 0);
  assert.equal(progress[0].total, 3);
  assert.equal(progress.at(-1).checked, 2);
  assert.equal(progress.at(-1).failed, 1);
  assert.equal(actual.rateLimited, true);
  assert.equal(calls, 2);
  assert.match(store.getSettings().lastLiveChartSyncSummary, /rate-limited/);
});

test('the status endpoint uses the existing web authentication', async (t) => {
  const { base } = await setup(t);
  const previous = process.env.WEB_PASSWORD;
  process.env.WEB_PASSWORD = 'background-test-password';
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_PASSWORD;
    else process.env.WEB_PASSWORD = previous;
  });
  assert.equal((await fetch(`${base}/api/livechart/sync-status`)).status, 401);
  const auth = Buffer.from(`${process.env.WEB_USER || 'admin'}:background-test-password`).toString('base64');
  assert.equal((await fetch(`${base}/api/livechart/sync-status`, { headers: { authorization: `Basic ${auth}` } })).status, 200);
});
