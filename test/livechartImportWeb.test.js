import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { load } from 'cheerio';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';

const link = 'https://www.livechart.me/anime/11218/schedules';
const fullDraft = { title: 'Kubo', scheduleLink: link, scheduleMode: 'livechart', liveChartLanguageStrict: true,
  liveChartImportLanguage: 'de', malId: '51815', imageUrl: 'https://example.com/kubo.jpg', episodeCount: 12,
  premiereDate: '2023-01-10', rawRelease: 'EP1–12', service: 'Amazon Prime Video', nextDate: '2026-10-01',
  releaseTime: '10:00', releaseDay: 'thursday', nextEpisode: 1, episodeBatchSize: 12,
  status: 'airing', enabled: true, weekly: false,
  languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 1, episodeBatchSize: 12,
    nextDate: '2026-10-01', releaseTime: '10:00', releaseDay: 'thursday', weekly: false }] };
const metadataDraft = { title: 'Kubo', scheduleLink: link, scheduleMode: 'manual', liveChartLanguageStrict: true,
  liveChartImportLanguage: 'de', malId: '51815', imageUrl: 'https://example.com/kubo.jpg', episodeCount: 12,
  premiereDate: '2023-01-10' };

async function setup(t, fetchSeriesDraft = async () => structuredClone(fullDraft)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-livechart-import-web-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createStore(path.join(dir, 'db.json'));
  await store.init();
  let posts = 0;
  const app = createWebApp(store, { enabled: false, async post() { posts += 1; } }, process.cwd(), { fetchSeriesDraft });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = () => process.env.WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || 'admin'}:${process.env.WEB_PASSWORD}`).toString('base64')}` } : {};
  const get = (route) => fetch(base + route, { headers: headers() });
  const preview = (body) => fetch(base + '/api/livechart/series-preview', { method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const save = (route, body) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: headers(), body });
  return { store, get, preview, save, base, posts: () => posts };
}

function formData(html) {
  const $ = load(html), result = new URLSearchParams();
  $('#series-form input, #series-form select, #series-form textarea').each((_, element) => {
    const input = $(element), name = input.attr('name');
    if (!name || (input.attr('type') === 'checkbox' && !input.is(':checked'))) return;
    result.append(name, input.attr('type') === 'checkbox' ? 'on' : input.val() || '');
  });
  return result;
}

test('series preview is authenticated, no-store, validated and never writes or posts', async (t) => {
  let calls = 0;
  const { store, preview, base, posts } = await setup(t, async (url, options) => {
    calls += 1;
    assert.equal(url, link);
    assert.equal(options.settings.timeZone, store.getSettings().timeZone);
    return structuredClone(fullDraft);
  });
  const originalPassword = process.env.WEB_PASSWORD;
  t.after(() => originalPassword === undefined ? delete process.env.WEB_PASSWORD : process.env.WEB_PASSWORD = originalPassword);
  process.env.WEB_PASSWORD = 'isolated-test-password';
  const unauthorized = await fetch(base + '/api/livechart/series-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleLink: link }) });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
  const before = store.snapshot();
  const disk = await fs.readFile(store.filePath, 'utf8');
  for (const scheduleLink of ['', 'https://evil.invalid/anime/11218', ['https://www.livechart.me/anime/11218']]) {
    const response = await preview({ scheduleLink });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await preview({ scheduleLink: link, seriesId: 'absent' })).status, 404);
  assert.equal(calls, 0);
  const response = await preview({ scheduleLink: link });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { draft: fullDraft });
  assert.deepEqual(store.snapshot(), before);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), disk);
  assert.equal(posts(), 0);
});

test('preview redirects duplicate identity to an existing series, while its own editor may load', async (t) => {
  let calls = 0;
  const { store, preview } = await setup(t, async () => { calls += 1; return structuredClone(fullDraft); });
  const existing = await store.upsertSeries({ title: 'Custom Kubo', scheduleLink: link, streamingServiceId: 'KEEP', note: 'Keep note' });
  const before = store.snapshot();
  const duplicate = await preview({ scheduleLink: 'https://livechart.me/anime/11218' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).existingSeriesId, existing.id);
  assert.equal(calls, 0);
  assert.equal((await preview({ scheduleLink: link, seriesId: existing.id })).status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(store.snapshot(), before);
});

test('preview detects MAL duplicates after reading metadata and reports fetch errors', async (t) => {
  let fail = false;
  const { store, preview } = await setup(t, async () => {
    if (fail) throw new Error('LiveChart temporarily unavailable');
    return structuredClone(metadataDraft);
  });
  const existing = await store.upsertSeries({ title: 'Kubo alias', malId: '51815' });
  const response = await preview({ scheduleLink: link });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).existingSeriesId, existing.id);
  fail = true;
  const failed = await preview({ scheduleLink: link });
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.match((await failed.json()).error, /temporarily unavailable/);
  assert.equal(store.listSeries().length, 1);
});

test('new and edit forms expose import controls and preserve imported metadata and nonweekly dubs through saves', async (t) => {
  const { store, get, save, posts } = await setup(t);
  const fresh = load(await (await get('/series/new')).text());
  assert.equal(fresh('[data-livechart-import]').attr('type'), 'button');
  assert.equal(fresh('select[name="scheduleMode"] option').length, 2);
  assert.equal(fresh('script[src="/livechart-import.js"]').length, 1);
  const existing = await store.upsertSeries({ ...fullDraft, title: 'My title', note: 'Keep note', streamingServiceId: 'KEEP' });
  const html = await (await get(`/series/${existing.id}`)).text();
  const $ = load(html);
  assert.equal($('input[name="scheduleLink"]').length, 1);
  assert.equal($('[data-livechart-import]').length, 1);
  assert.equal($('input[name="languageWeekly_de"]').val(), '0');
  const body = formData(html);
  body.set('scheduleMode', 'manual');
  assert.equal((await save(`/series/${existing.id}`, body)).status, 302);
  const saved = store.getSeries(existing.id);
  for (const property of ['malId', 'rawRelease', 'liveChartLanguageStrict', 'liveChartImportLanguage', 'note', 'title', 'streamingServiceId']) {
    assert.equal(saved[property], existing[property], property);
  }
  assert.equal(saved.scheduleMode, 'manual');
  assert.equal(saved.weekly, false);
  assert.equal(saved.languageTracks.find(track => track.code === 'de').weekly, false);
  for (const name of ['scheduleMode', 'malId', 'rawRelease', 'liveChartLanguageStrict', 'liveChartImportLanguage', 'languageWeekly_de']) body.delete(name);
  assert.equal((await save(`/series/${existing.id}`, body)).status, 302);
  const legacySaved = store.getSeries(existing.id);
  assert.equal(legacySaved.scheduleMode, 'manual');
  assert.equal(legacySaved.malId, '51815');
  assert.equal(legacySaved.liveChartLanguageStrict, true);
  assert.equal(legacySaved.languageTracks.find(track => track.code === 'de').weekly, false);
  assert.equal(posts(), 0);
});

// Run the actual browser script against controls from the rendered HTML. Network
// promises are held explicitly so edits and stale responses can be reproduced.
async function client(html) {
  const $ = load(html), requests = [], controls = [];
  const makeElement = (name = '', value = '', type = 'text', dataset = {}) => ({
    name, value, type, dataset, checked: false, textContent: '', disabled: false, listeners: new Map(), children: [],
    addEventListener(event, fn) { this.listeners.set(event, [...(this.listeners.get(event) || []), fn]); },
    async dispatchEvent(event) {
      event.target ||= this;
      for (const fn of this.listeners.get(event.type) || []) await fn(event);
      if (event.bubbles && this !== form) await form.dispatchEvent(event);
    },
    append(child) { this.children.push(child); }
  });
  $('#series-form input, #series-form select, #series-form textarea').each((_, element) => {
    const input = $(element), control = makeElement(input.attr('name'), input.val() || '', input.attr('type') || 'text');
    control.checked = input.is(':checked');
    controls.push(control);
  });
  controls.namedItem = (name) => controls.find(control => control.name === name);
  const importButton = makeElement(), status = makeElement(), titleStatus = makeElement(), presetStatus = makeElement();
  const presets = ['weekly', 'complete'].map(value => makeElement('', '', 'button', { releasePreset: value }));
  const form = Object.assign(makeElement(), { elements: controls, dataset: { seriesId: $('#series-form').attr('data-series-id') },
    querySelector: (selector) => ({ '[data-livechart-import]': importButton, '[data-livechart-import-status]': status,
      '[data-release-preset-status]': presetStatus })[selector],
    querySelectorAll: () => presets });
  const document = { getElementById: id => id === 'series-form' ? form : titleStatus, createElement: () => makeElement() };
  let timerId = 0;
  vm.runInNewContext(await fs.readFile(new URL('../public/livechart-import.js', import.meta.url), 'utf8'), {
    document, URL, AbortController, Event: class { constructor(type, options = {}) { Object.assign(this, { type, ...options }); } },
    setTimeout: () => ++timerId, clearTimeout: () => {},
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve }))
  });
  const input = controls.namedItem;
  const edit = async (name, value) => {
    const control = input(name);
    if (control.type === 'checkbox') control.checked = value; else control.value = value;
    await control.dispatchEvent({ type: 'input', bubbles: true });
  };
  const start = () => importButton.dispatchEvent({ type: 'click' });
  const respond = (index, data, ok = true) => requests[index].resolve({ ok, json: async () => data });
  const preset = (name) => presets.find(item => item.dataset.releasePreset === name).dispatchEvent({ type: 'click' });
  return { input, edit, start, respond, requests, status, preset, presetStatus };
}

test('metadata-only drafts keep manual release fields, custom title, notes and service IDs', async (t) => {
  const { get } = await setup(t);
  const browser = await client(await (await get('/series/new')).text());
  for (const [name, value] of Object.entries({ scheduleLink: link, title: 'My Kubo', nextDate: '2026-10-09',
    service: 'My Amazon listing', releaseTime: '18:30', streamingServiceId: 'B0KEEP', note: 'Personal note', languageNextDate_de: '2026-11-01' })) await browser.edit(name, value);
  const pending = browser.start();
  browser.respond(0, { draft: metadataDraft });
  await pending;
  assert.equal(browser.input('scheduleMode').value, 'manual');
  assert.equal(browser.input('title').value, 'My Kubo');
  assert.equal(browser.input('service').value, 'My Amazon listing');
  assert.equal(browser.input('nextDate').value, '2026-10-09');
  assert.equal(browser.input('releaseTime').value, '18:30');
  assert.equal(browser.input('languageNextDate_de').value, '2026-11-01');
  assert.equal(browser.input('note').value, 'Personal note');
  assert.equal(browser.input('streamingServiceId').value, 'B0KEEP');
  assert.match(browser.status.textContent, /No upcoming German release/);
  assert.equal(browser.requests.length, 1);
});

test('draft loading preserves edits during the request and ignores stale link responses', async (t) => {
  const { get } = await setup(t);
  const browser = await client(await (await get('/series/new')).text());
  await browser.edit('scheduleLink', link);
  const pending = browser.start();
  await browser.edit('service', 'User service');
  await browser.edit('releaseTime', '12:00');
  await browser.edit('releaseTime', ''); // Even an edit reverted to its old value belongs to the user.
  await browser.edit('languageNextDate_de', '2026-11-01');
  browser.respond(0, { draft: fullDraft });
  await pending;
  assert.equal(browser.input('service').value, 'User service');
  assert.equal(browser.input('releaseTime').value, '');
  assert.equal(browser.input('languageNextDate_de').value, '2026-11-01');
  assert.equal(browser.input('nextDate').value, fullDraft.nextDate);
  assert.equal(browser.input('weekly').checked, false);
  assert.equal(browser.input('languageWeekly_de').value, '0');
  assert.equal(browser.input('liveChartLanguageStrict').value, '1');
  const stale = browser.start();
  await browser.edit('scheduleLink', 'https://www.livechart.me/anime/99');
  browser.respond(1, { draft: { ...fullDraft, service: 'STALE' } });
  await stale;
  assert.equal(browser.input('service').value, 'User service');
  assert.equal(browser.status.textContent, '');
  assert.equal(browser.requests.length, 2);
});

test('complete and weekly presets affect only the main release and require a known total', async (t) => {
  const { get } = await setup(t);
  const browser = await client(await (await get('/series/new')).text());
  await browser.edit('languageEpisode_de', '7');
  await browser.edit('languageWeekly_de', '0');
  await browser.preset('complete');
  assert.match(browser.presetStatus.textContent, /Enter the total/);
  assert.equal(browser.input('nextEpisode').value, '');
  await browser.edit('episodeCount', '12');
  await browser.preset('complete');
  assert.equal(browser.input('nextEpisode').value, '1');
  assert.equal(browser.input('episodeBatchSize').value, '12');
  assert.equal(browser.input('weekly').checked, false);
  await browser.preset('weekly');
  assert.equal(browser.input('episodeBatchSize').value, '1');
  assert.equal(browser.input('weekly').checked, true);
  assert.equal(browser.input('languageEpisode_de').value, '7');
  assert.equal(browser.input('languageWeekly_de').value, '0');
  assert.equal(browser.requests.length, 0);
});

test('release presets reactivate a finished disabled series without changing its dub tracks or saving', async (t) => {
  const { store, get } = await setup(t);
  const existing = await store.upsertSeries({ title: 'Old series', status: 'finished', enabled: false,
    nextEpisode: null, episodeCount: 12, languageTracks: [{ code: 'de', enabled: false, nextEpisode: null, weekly: false }] });
  for (const preset of ['weekly', 'complete']) {
    const browser = await client(await (await get(`/series/${existing.id}`)).text());
    await browser.preset(preset);
    assert.equal(browser.input('enabled').checked, true);
    assert.equal(browser.input('status').value, 'planned');
    assert.equal(browser.input('nextEpisode').value, '1');
    assert.equal(browser.input('episodeBatchSize').value, preset === 'complete' ? '12' : '1');
    assert.equal(browser.input('weekly').checked, preset === 'weekly');
    assert.equal(browser.input('languageEnabled_de').checked, false);
    assert.equal(browser.input('languageEpisode_de').value, '');
    assert.equal(browser.requests.length, 0);
    assert.equal(store.getSeries(existing.id).enabled, false);
  }
});
