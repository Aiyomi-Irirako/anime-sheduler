import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { load } from 'cheerio';
import { getNextAnnouncementRelease } from '../src/schedule.js';
import { buildAnnouncement } from '../src/discordBot.js';
import { createStore } from '../src/store.js';
import { createWebApp } from '../src/web.js';
import { fetchLiveChartSeriesDraft } from '../src/livechartImport.js';

const settings = { timeZone: 'Europe/Berlin', missingTimePostTime: '18:00' };
const now = DateTime.fromISO('2026-10-01T12:00:00', { zone: settings.timeZone });
const dub = (overrides = {}) => ({ code: 'de', enabled: true, available: true, nextEpisode: 1,
  nextDate: '2026-10-22', releaseTime: '17:00', episodeBatchSize: 1, weekly: true, ...overrides });
const series = (overrides = {}) => ({ id: 'dragon-hatchling', title: 'Reincarnated as a Dragon Hatchling',
  service: 'ADN', enabled: true, status: 'airing', nextEpisode: 2, episodeCount: 12,
  nextDate: '2026-10-29', releaseTime: '17:00', episodeBatchSize: 1,
  languageTracks: [dub()], ...overrides });
const field = (message, name) => message.embeds[0].toJSON().fields.find(item => item.name.startsWith(name))?.value;

test('the earlier German dub is selected before a later original and described as German', () => {
  const entry = series();
  const release = getNextAnnouncementRelease(entry, settings, now);
  assert.equal(release.kind, 'language');
  assert.equal(release.languageCode, 'de');
  assert.equal(release.episode, 1);
  assert.equal(release.dateTime.toISODate(), '2026-10-22');
  const message = buildAnnouncement(entry, release, settings);
  assert.equal(field(message, 'Version'), 'German');
  assert.equal(field(message, 'Episode'), 'Episode 01/12 (German)');
});

test('a new October 22 dub takes precedence over a stale saved original date', () => {
  const release = getNextAnnouncementRelease(series({ nextDate: '2026-03-25' }), settings, now);
  assert.equal(release.kind, 'language');
  assert.equal(release.dateTime.toISODate(), '2026-10-22');
});

test('an original still inside the six-hour posting window comes before the future dub', () => {
  const release = getNextAnnouncementRelease(series({ nextDate: '2026-10-01', releaseTime: '06:00' }), settings, now);
  assert.equal(release.kind, 'main');
  const afterExpiry = getNextAnnouncementRelease(series({ nextDate: '2026-10-01', releaseTime: '06:00' }),
    settings, now.plus({ seconds: 1 }));
  assert.equal(afterExpiry.kind, 'language');
});

test('a dub-only series can announce its next release after the original has finished', () => {
  const release = getNextAnnouncementRelease(series({ status: 'finished', nextEpisode: null, nextDate: '' }), settings, now);
  assert.equal(release.kind, 'language');
  assert.equal(release.languageCode, 'de');
});

test('simultaneous dubs combine without inventing an original version', () => {
  const entry = series({ status: 'finished', nextEpisode: null,
    languageTracks: [dub(), dub({ code: 'en', nextEpisode: 3 })] });
  const release = getNextAnnouncementRelease(entry, settings, now);
  assert.equal(release.kind, 'combined');
  assert.deepEqual(release.releases.map(item => item.languageCode), ['de', 'en']);
  assert.deepEqual(release.releases.map(item => item.episode), [1, 3]);
  assert.equal(field(buildAnnouncement(entry, release, settings), 'Version'), 'German + English');
});

test('an original and dubs combine only when their posting times and time precision agree', () => {
  const exact = getNextAnnouncementRelease(series({ nextDate: '2026-10-22' }), settings, now);
  assert.equal(exact.kind, 'combined');
  assert.deepEqual(exact.releases.map(item => item.kind), ['main', 'language']);
  const missing = getNextAnnouncementRelease(series({ nextDate: '2026-10-22', releaseTime: '',
    languageTracks: [dub({ releaseTime: '' })] }), settings, now);
  assert.equal(missing.kind, 'combined');
  assert.equal(missing.missingTime, true);
  const mixed = getNextAnnouncementRelease(series({ nextDate: '2026-10-22', releaseTime: '18:00',
    languageTracks: [dub({ releaseTime: '' })] }), settings, now);
  assert.equal(mixed.kind, 'main');
  assert.equal(mixed.missingTime, false);
  const separate = getNextAnnouncementRelease(series({ nextDate: '2026-10-22', releaseTime: '19:00' }), settings, now);
  assert.equal(separate.kind, 'language');
});

test('disabled series and tracks cannot create manual announcement candidates', () => {
  assert.equal(getNextAnnouncementRelease(series({ enabled: false }), settings, now), null);
  const release = getNextAnnouncementRelease(series({ languageTracks: [dub({ enabled: false })] }), settings, now);
  assert.equal(release.kind, 'main');
  assert.equal(getNextAnnouncementRelease(series({ status: 'finished', languageTracks: [dub({ enabled: false })] }), settings, now), null);
  assert.equal(getNextAnnouncementRelease(series({ status: 'finished', languageTracks: [dub({ nextDate: '', releaseDay: '' })] }), settings, now), null);
});

test('a historical release can still be previewed when no current release exists', () => {
  const release = getNextAnnouncementRelease(series({ nextDate: '2026-03-25', languageTracks: [] }), settings, now);
  assert.equal(release.kind, 'main');
  assert.equal(release.dateTime.toISODate(), '2026-03-25');
});

async function setupWeb(t, input) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-announcement-selection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings });
  const entry = await store.upsertSeries(input);
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) { messages.push(message); } };
  const app = createWebApp(store, discord, process.cwd());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = process.env.WEB_PASSWORD ? {
    Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || 'admin'}:${process.env.WEB_PASSWORD}`).toString('base64')}`
  } : {};
  return { store, entry, messages, base, headers };
}

test('the test-post web action sends a German dub-only announcement to fake Discord', async t => {
  const { store, entry, messages, base, headers } = await setupWeb(t,
    series({ status: 'finished', nextEpisode: null, nextDate: '' }));
  const response = await fetch(`${base}/series/${entry.id}/test-post`, { method: 'POST', redirect: 'manual', headers,
    body: new URLSearchParams({ title: entry.title, service: 'ADN', status: 'finished', enabled: 'on',
      nextEpisode: '', episodeCount: '12', nextDate: '', languageCodes: 'de', languageEnabled_de: 'on',
      languageAvailable_de: '1', languageEpisode_de: '1', languageBatchSize_de: '1',
      languageNextDate_de: '2026-10-22', languageReleaseTime_de: '17:00' }) });
  assert.equal(new URL(response.headers.get('location'), base).searchParams.get('ok'), 'Test post sent');
  assert.equal(messages.length, 1);
  assert.equal(field(messages[0], 'Version'), 'German');
  assert.equal(field(messages[0], 'Episode'), 'Episode 01/12 (German)');
  assert.equal(store.snapshot().posts[0].type, 'manual-test');
  const saved = store.getSeries(entry.id);
  assert.equal(saved.languageTracks.find(track => track.code === 'de').nextEpisode, 1);
  assert.equal(saved.languageTracks.find(track => track.code === 'de').lastPostedKey, '');
});

test('a Dragon Hatchling LiveChart dub-only import produces a German October 22 test post', async t => {
  const animeUrl = 'https://www.livechart.me/anime/13087';
  const detailHtml = `<meta property="og:title" content="Reincarnated as a Dragon Hatchling | LiveChart.me">
    <div>Episodes 12</div>`;
  // The relevant rows observed on LiveChart: the original is released; only a
  // German dub on ADN has a forthcoming date, including a confirmation warning.
  const scheduleHtml = `<article data-release-schedule-release-schedule-id="1">
    <a href="${animeUrl}/schedules/1" title="Simulcast: Subbed">Released</a>
    <span><svg><use href="#icon:subtitles"></use></svg></span>
    <span data-tracklist-json="{&quot;de&quot;:[&quot;DE&quot;]}"></span></article>
    <article data-release-schedule-release-schedule-id="2">
    <a href="${animeUrl}/schedules/2" title="Streaming: Dubbed">
    <time data-label="EP1" data-timestamp="1792620000">EP1</time>This release requires confirmation.</a>
    <span><svg><use href="#icon:audio"></use></svg></span>
    <span data-tracklist-json="{&quot;de&quot;:[&quot;DE&quot;]}"></span>
    <span class="lc-text-contextual-accent">Animation Digital Network</span></article>`;
  const draft = await fetchLiveChartSeriesDraft(`${animeUrl}/schedules`, { settings, now,
    fetchHtml: async url => {
      assert.ok(url === animeUrl || url === `${animeUrl}/schedules`);
      return url === animeUrl ? detailHtml : scheduleHtml;
    } });
  assert.equal(draft.nextEpisode, null);
  assert.equal(draft.nextDate, '');
  assert.equal(draft.service, 'ADN');
  assert.equal(draft.languageTracks[0].nextDate, '2026-10-22');
  assert.equal(draft.languageTracks[0].releaseTime, '00:00');
  const { store, entry, messages, base, headers } = await setupWeb(t, draft);
  const $ = load(await (await fetch(`${base}/series/${entry.id}`, { headers })).text());
  const body = new URLSearchParams();
  $('#series-form input, #series-form select, #series-form textarea').each((_, element) => {
    const input = $(element), name = input.attr('name');
    if (!name || (input.attr('type') === 'checkbox' && !input.is(':checked'))) return;
    body.append(name, input.attr('type') === 'checkbox' ? 'on' : input.val() || '');
  });
  const response = await fetch(`${base}/series/${entry.id}/test-post`, {
    method: 'POST', redirect: 'manual', headers, body
  });
  assert.equal(new URL(response.headers.get('location'), base).searchParams.get('ok'), 'Test post sent');
  assert.equal(messages.length, 1);
  assert.equal(field(messages[0], 'Version'), 'German');
  assert.equal(field(messages[0], 'Date'), 'Thu, 22 Oct 2026');
  assert.equal(field(messages[0], 'Time'), '00:00');
  assert.equal(field(messages[0], 'Service'), 'ADN');
  assert.equal(field(messages[0], 'Episode'), 'Episode 01/12 (German)');
  assert.equal(store.getSeries(entry.id).languageTracks[0].nextEpisode, 1);
  assert.equal(store.getSeries(entry.id).languageTracks[0].lastPostedKey, '');
});
