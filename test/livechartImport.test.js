import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { fetchLiveChartSeriesDraft } from '../src/livechartImport.js';
import { fetchLiveChartEpisodes, parseLiveChartEpisodes } from '../src/livechart.js';
import { createLiveChartClient } from '../src/livechartHttp.js';
import { getNextRelease, getNextLanguageRelease, getReleasePostDateTime } from '../src/schedule.js';

const now = DateTime.fromISO('2026-09-30T12:00:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'en', enabledLanguageCodes: ['en'] };
const base = 'https://www.livechart.me/anime/11218';
const detail = ({ count = 12 } = {}) => `<html><head><meta property="og:title" content="Kubo Won't Let Me Be Invisible | LiveChart.me">
  <meta property="og:image" content="https://u.livechart.me/anime/11218/poster_image/example/large.jpg"></head>
  <body><div><div>Premiere</div><a>Jan 10, 2023</a></div>${count === null ? '' : `<div>Episodes ${count}</div>`}
  <a href="https://myanimelist.net/anime/51815">MyAnimeList</a></body></html>`;
const tracks = (type, code) => `<span><svg><use href="#icon:${type}"></use></svg></span>
  <span data-tracklist-json="{&quot;${code}&quot;:[&quot;DE&quot;]}"></span>`;
const row = ({ id = '20', label = 'All12EPs', date = '2026-10-01', precision = 3,
  stamp = null, title = 'Streaming: Subbed', sub = 'de', audio = 'ja', service = 'Prime Video', region = false } = {}) =>
  `<article data-release-schedule-release-schedule-id="${id}"><a href="/anime/11218/schedules/${id}" title="${title}">
    <span data-label="${label}">${label}</span><time ${stamp ? `data-timestamp="${stamp.toSeconds()}"` :
      `data-intl-time-datetime="${date}" data-intl-time-precision="${precision}"`}></time>
    ${region ? 'This schedule might not apply to your region.' : ''}</a>
    ${tracks('subtitles', sub)}${tracks('audio', audio)}<span class="lc-text-contextual-accent">${service}</span></article>`;
function fakePages(scheduleHtml, detailHtml = detail()) {
  const requests = [];
  return { requests, fetchHtml: async (url, options) => {
    requests.push({ url, options });
    if (url === base) return detailHtml;
    assert.equal(url, `${base}/schedules`);
    return scheduleHtml;
  } };
}
async function draft(html, { link = base, detailHtml = detail() } = {}) {
  const pages = fakePages(html, detailHtml);
  return { result: await fetchLiveChartSeriesDraft(link, { settings, now, fetchHtml: pages.fetchHtml }), ...pages };
}

test('imports an old title with a new German date-only season batch and excludes old services', async () => {
  const html = row({ id: '1', label: 'Released', service: 'Crunchyroll' }) +
    row({ id: '2', sub: 'en', service: 'Netflix' }) + row();
  const { result, requests } = await draft(html);
  assert.equal(result.title, "Kubo Won't Let Me Be Invisible");
  assert.equal(result.premiereDate, '2023-01-10');
  assert.equal(result.nextDate, '2026-10-01');
  assert.equal(result.releaseTime, '');
  assert.equal(result.releaseDay, 'thursday');
  assert.equal(result.nextEpisode, 1);
  assert.equal(result.episodeBatchSize, 12);
  assert.equal(result.episodeCount, 12);
  assert.equal(result.weekly, false);
  assert.equal(result.service, 'Prime Video');
  assert.equal(result.malId, '51815');
  assert.match(result.imageUrl, /\/small\.jpg$/);
  assert.equal(result.scheduleLink, `${base}/schedules`);
  assert.equal(result.scheduleMode, 'livechart');
  assert.equal(result.liveChartLanguageStrict, true);
  assert.equal(result.liveChartImportLanguage, 'de');
  assert.equal(result.enabled, true);
  const release = getNextRelease(result, settings, now);
  assert.equal(release.episodeEnd, 12);
  assert.equal(getReleasePostDateTime(release, { ...settings, missingTimePostTime: '18:00' }).toISO(),
    '2026-10-01T18:00:00.000+02:00');
  assert.deepEqual(requests.map(item => item.url), [base, `${base}/schedules`]);
  const synced = parseLiveChartEpisodes(html, { preferredLanguageCodes: ['de'], nowTimestamp: now.toSeconds() });
  assert.equal(synced.service, 'Prime Video');
  assert.equal(synced.episodeBatchSize, 12);
});

test('imports a weekly German release with its actual time regardless of original premiere', async () => {
  const stamp = DateTime.fromISO('2026-10-01T17:30:00+02:00');
  const { result } = await draft(row({ label: 'EP1', stamp }));
  assert.equal(result.weekly, true);
  assert.equal(result.episodeBatchSize, 1);
  assert.equal(result.releaseTime, '17:30');
  assert.equal(getNextRelease(result, settings, now).dateTime.toISO(), stamp.toISO());
});

test('imports a German dub alone without scheduling an older subtitle or foreign dub', async () => {
  const html = row({ id: '1', label: 'Released', service: 'Crunchyroll' }) +
    row({ id: '2', title: 'Streaming: Dubbed', sub: 'en', audio: 'en', service: 'Netflix' }) +
    row({ title: 'Streaming: Dubbed', sub: 'en', audio: 'de' });
  const { result } = await draft(html);
  assert.equal(result.nextEpisode, null);
  assert.equal(result.nextDate, '');
  assert.equal(getNextRelease(result, settings, now), null);
  assert.equal(result.service, 'Prime Video');
  assert.deepEqual(result.languageTracks.map(track => track.code), ['de']);
  const track = result.languageTracks[0];
  assert.equal(track.enabled, true);
  assert.equal(track.weekly, false);
  assert.equal(track.nextDate, '2026-10-01');
  assert.equal(getNextLanguageRelease(result, track, settings, now).episodeEnd, 12);
});

test('returns metadata only in manual mode when an older title has no upcoming German schedule', async () => {
  const { result } = await draft(row({ label: 'Released', service: 'Crunchyroll' }) +
    row({ id: '21', sub: 'en' }));
  assert.equal(result.scheduleMode, 'manual');
  assert.equal(result.title, "Kubo Won't Let Me Be Invisible");
  assert.equal(result.premiereDate, '2023-01-10');
  assert.equal(result.episodeCount, 12);
  for (const field of ['service', 'nextEpisode', 'episodeBatchSize', 'nextDate', 'releaseDay', 'releaseTime',
    'weekly', 'status', 'enabled', 'languageTracks', 'rawRelease']) {
    assert.equal(Object.hasOwn(result, field), false, `${field} must not replace manual input`);
  }
});

test('specific schedule links keep the chosen service through import and later sync', async () => {
  const html = row({ id: '19', label: 'EP1', service: 'Crunchyroll' }) + row();
  const link = 'http://livechart.me/anime/011218/schedules/020/?utm_source=test#schedule';
  const { result } = await draft(html, { link });
  assert.equal(result.scheduleLink, `${base}/schedules/20`);
  assert.equal(result.episodeBatchSize, 12);
  assert.equal(result.service, 'Prime Video');
  const pages = fakePages(html);
  const synced = await fetchLiveChartEpisodes(result.scheduleLink, { fetchHtml: pages.fetchHtml,
    requirePreferredLanguage: true, preferredLanguageCodes: ['de'], nowTimestamp: now.toSeconds() });
  assert.equal(synced.service, 'Prime Video');
  assert.equal(synced.episodeBatchSize, 12);
  assert.deepEqual(pages.requests.map(item => item.url), [`${base}/schedules`, base]);
});

test('a specific schedule that disappears fails instead of silently switching service', async () => {
  const pages = fakePages(row());
  await assert.rejects(fetchLiveChartSeriesDraft(`${base}/schedules/99`, { fetchHtml: pages.fetchHtml, now }), /could not be found/);
  await assert.rejects(fetchLiveChartEpisodes(`${base}/schedules/99`, { fetchHtml: pages.fetchHtml }), /could not be found/);
});

test('a specific released, foreign, expired or region-inapplicable schedule is rejected', async () => {
  for (const options of [{ label: 'Released' }, { sub: 'en' }, { date: '2026-09-01' }, { region: true }]) {
    const html = row(options) + row({ id: '21' });
    await assert.rejects(draft(html, { link: `${base}/schedules/20` }), /no upcoming German/);
  }
});

test('unselected expired and region-inapplicable German schedules leave manual fields untouched', async () => {
  const { result } = await draft(row({ date: '2026-09-01' }) + row({ id: '21', region: true }));
  assert.equal(result.scheduleMode, 'manual');
  assert.equal(Object.hasOwn(result, 'nextDate'), false);
});

test('All-N labels can supply missing total episode metadata but an episode range cannot', async () => {
  for (const label of ['All12EPs', 'All 12 EPs']) {
    const { result } = await draft(row({ label }), { detailHtml: detail({ count: null }) });
    assert.equal(result.episodeCount, 12);
    assert.equal(result.weekly, false);
  }
  const { result } = await draft(row({ label: 'EP1-12' }), { detailHtml: detail({ count: null }) });
  assert.equal(result.episodeCount, null);
  assert.equal(result.episodeBatchSize, 12);
  assert.equal(result.weekly, true);
});

test('month/year-only and unknown-episode schedules do not invent a posting date', async () => {
  for (const options of [{ precision: 2, date: '2026-10-01' }, { precision: 1, date: '2026-01-01' }, { label: 'TBA' }]) {
    const { result } = await draft(row(options));
    assert.equal(result.scheduleMode, 'livechart');
    assert.equal(result.nextDate, '');
    assert.equal(result.releaseTime, '');
    assert.equal(getNextRelease(result, settings, now), null);
  }
});

test('invalid hosts and paths are rejected before any fetch', async () => {
  let fetched = false;
  for (const link of ['https://example.com/anime/11218', `${base}/news`, `${base}/schedules/0`,
    'https://user:secret@www.livechart.me/anime/11218']) {
    await assert.rejects(fetchLiveChartSeriesDraft(link, { fetchHtml: async () => { fetched = true; } }), /LiveChart/);
  }
  assert.equal(fetched, false);
});

test('unreadable schedule pages are reported instead of clearing a schedule', async () => {
  await assert.rejects(draft('<html>Changed layout</html>'), /No LiveChart schedules/);
  await assert.rejects(draft(row(), { detailHtml: '<html><title>LiveChart.me</title></html>' }), /No series title/);
});

test('the draft loader shares the existing serial client delay and propagates access failures', async () => {
  let milliseconds = 0;
  const waits = [], calls = [];
  const fetchHtml = createLiveChartClient({ now: () => milliseconds,
    wait: async ms => { waits.push(ms); milliseconds += ms; },
    fetchImpl: async url => { calls.push(url); return new Response(url === base ? detail() : row()); } });
  const result = await fetchLiveChartSeriesDraft(base, { fetchHtml, now });
  assert.equal(result.scheduleMode, 'livechart');
  assert.deepEqual(calls, [base, `${base}/schedules`]);
  assert.deepEqual(waits, [6500]);

  let blockedRequests = 0;
  const blockedClient = createLiveChartClient({ fetchImpl: async () => {
    blockedRequests += 1;
    return new Response('', { status: 429 });
  } });
  await assert.rejects(fetchLiveChartSeriesDraft(base, { fetchHtml: blockedClient, now }), error => error.status === 429);
  await assert.rejects(fetchLiveChartSeriesDraft(base, { fetchHtml: blockedClient, now }), /paused/);
  assert.equal(blockedRequests, 1);
});
