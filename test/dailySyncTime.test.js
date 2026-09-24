import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { normalizeDailyTime } from '../src/utils.js';
import { shouldRunDailyLiveChartSync, startLiveChartDailySync } from '../src/livechartSync.js';
import { shouldRunDiscovery, startDailyDiscovery } from '../src/livechartDiscovery.js';
import { createWebApp } from '../src/web.js';

async function setup(t, settings = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-daily-time-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.replaceData({ settings });
  return store;
}

test('hour-only backups migrate without losing their existing schedule', async (t) => {
  const store = await setup(t, { liveChartSyncHour: 7, liveChartDiscoveryHour: 22 });
  assert.equal(store.getSettings().liveChartSyncTime, '07:00');
  assert.equal(store.getSettings().liveChartDiscoveryTime, '22:00');
  const restored = createStore(store.filePath);
  await restored.init();
  assert.equal(restored.getSettings().liveChartSyncTime, '07:00');
  assert.equal(restored.getSettings().liveChartDiscoveryTime, '22:00');
  await store.replaceData({ settings: {} });
  assert.equal(store.getSettings().liveChartSyncTime, '05:00');
  assert.equal(store.getSettings().liveChartDiscoveryTime, '06:00');
});

test('minute settings survive save/reload and invalid or omitted updates', async (t) => {
  const store = await setup(t);
  await store.updateSettings({ liveChartSyncTime: '5:15', liveChartDiscoveryTime: '06:37' });
  assert.equal(store.getSettings().liveChartSyncTime, '05:15');
  assert.equal(store.getSettings().liveChartDiscoveryTime, '06:37');
  await store.updateSettings({ liveChartSyncTime: '24:00', liveChartDiscoveryTime: '06:60' });
  await store.updateSettings({ timeZone: 'Europe/Berlin' });
  const restored = createStore(store.filePath);
  await restored.init();
  assert.equal(restored.getSettings().liveChartSyncTime, '05:15');
  assert.equal(restored.getSettings().liveChartDiscoveryTime, '06:37');
  await restored.updateSettings({ liveChartSyncHour: '8', liveChartDiscoveryHour: '9' });
  assert.equal(restored.getSettings().liveChartSyncTime, '08:00');
  assert.equal(restored.getSettings().liveChartDiscoveryTime, '09:00');
  assert.equal(normalizeDailyTime('', undefined, 6), '06:00');
  assert.equal(normalizeDailyTime('00:00', 7), '00:00');
  assert.equal(normalizeDailyTime('23:59', 7), '23:59');
});

for (const kind of ['sync', 'discovery']) {
  const isSync = kind === 'sync';
  const prefix = isSync ? 'liveChartSync' : 'liveChartDiscovery';
  const due = (settings, last, now) => isSync
    ? shouldRunDailyLiveChartSync({ ...settings, lastLiveChartSyncAt: last }, now)
    : shouldRunDiscovery(settings, { lastAttemptAt: last }, now);
  const at = (value) => DateTime.fromISO(value, { zone: 'Europe/Berlin' });

  test(`${kind} starts at the chosen minute, once daily, and catches up after restart`, () => {
    const settings = { timeZone: 'Europe/Berlin', [`${prefix}Enabled`]: true, [`${prefix}Time`]: '05:15' };
    assert.equal(due(settings, '', at('2026-09-25T05:14:59')), false);
    assert.equal(due(settings, '', at('2026-09-25T05:15:00')), true);
    assert.equal(due(settings, '', at('2026-09-25T11:00:00')), true);
    assert.equal(due(settings, '2026-09-25T05:15:10+02:00', at('2026-09-25T23:00:00')), false);
    assert.equal(due(settings, '2026-09-25T05:15:10+02:00', at('2026-09-26T05:15:00')), true);
    assert.equal(due({ ...settings, [`${prefix}Enabled`]: false }, '', at('2026-09-25T05:15:00')), false);
    assert.equal(due({ ...settings, [`${prefix}Time`]: undefined, [`${prefix}Hour`]: 5 }, '', at('2026-09-25T05:00:00')), true);
  });

  test(`${kind} respects timezones, midnight, and repeated daylight-saving hours`, () => {
    const settings = { timeZone: 'Europe/Berlin', [`${prefix}Enabled`]: true, [`${prefix}Time`]: '05:15' };
    assert.equal(due(settings, '', DateTime.fromISO('2026-09-25T03:14:59Z')), false);
    assert.equal(due(settings, '', DateTime.fromISO('2026-09-25T03:15:00Z')), true);
    assert.equal(due(settings, '2026-09-24T23:30:00Z', at('2026-09-25T05:15:00')), false);
    const midnight = { ...settings, [`${prefix}Time`]: '00:00' };
    assert.equal(due(midnight, '2026-09-24T23:59:00+02:00', at('2026-09-25T00:00:00')), true);
    const late = { ...settings, [`${prefix}Time`]: '23:59' };
    assert.equal(due(late, '', at('2026-09-25T23:58:59')), false);
    assert.equal(due(late, '', at('2026-09-25T23:59:00')), true);
    const dst = { ...settings, [`${prefix}Time`]: '02:15' };
    assert.equal(due(dst, '', DateTime.fromISO('2026-03-29T03:00:00+02:00')), true);
    assert.equal(due(dst, '2026-10-25T02:15:00+02:00', DateTime.fromISO('2026-10-25T02:15:00+01:00')), false);
  });
}

test('both daily timers check locally every minute without starting disabled jobs', (t) => {
  const callbacks = [];
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 60000);
    callbacks.push(callback);
    return callbacks.length;
  });
  const store = { getSettings: () => ({ liveChartSyncEnabled: false, liveChartDiscoveryEnabled: false }), getDiscovery: () => ({}) };
  startLiveChartDailySync(store);
  startDailyDiscovery(store);
  assert.equal(callbacks.length, 2);
  for (const callback of callbacks) callback();
});

test('Settings exposes minute inputs and persists both times through the form', async (t) => {
  const store = await setup(t, { liveChartSyncHour: 5, liveChartDiscoveryHour: 6 });
  const discord = { enabled: false, listTextChannels: async () => [], listMentionRoles: async () => [] };
  const app = createWebApp(store, discord, process.cwd());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/settings`;
  const $ = load(await (await fetch(url)).text());
  for (const name of ['liveChartSyncTime', 'liveChartDiscoveryTime']) {
    assert.equal($(`input[name="${name}"]`).attr('type'), 'time');
    assert.equal($(`input[name="${name}"]`).attr('step'), '60');
  }
  assert.equal($('input[name="liveChartSyncHour"], input[name="liveChartDiscoveryHour"]').length, 0);
  const response = await fetch(url, { method: 'POST', redirect: 'manual', body: new URLSearchParams({
    liveChartSyncEnabled: 'on', liveChartDiscoveryEnabled: 'on', liveChartSyncTime: '05:15', liveChartDiscoveryTime: '06:37'
  }) });
  assert.equal(response.status, 302);
  const updated = load(await (await fetch(url)).text());
  assert.equal(updated('input[name="liveChartSyncTime"]').val(), '05:15');
  assert.equal(updated('input[name="liveChartDiscoveryTime"]').val(), '06:37');
  const restored = createStore(store.filePath);
  await restored.init();
  assert.equal(restored.getSettings().liveChartSyncTime, '05:15');
  assert.equal(restored.getSettings().liveChartDiscoveryTime, '06:37');
});
