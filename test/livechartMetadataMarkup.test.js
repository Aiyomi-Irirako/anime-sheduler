import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveChartEpisodes, parseLiveChartMetadata } from '../src/livechart.js';

const url = 'https://www.livechart.me/anime/12991';
const detail = (total = '12') => `<html><head>
  <meta property="og:title" content="Appraisal Skill Season 3 | LiveChart.me">
  <meta property="og:image" content="https://u.livechart.me/anime/12991/poster_image/example/large.jpg">
  </head><body><div><div>Premiere</div><a href="/schedule?date=2026-09-27">
  <time datetime="2026-09-27T15:00:00Z" data-controller="formatted-temporal"
    data-formatted-temporal-format="date" data-formatted-temporal-precision="4">September 27, 2026</time>
  </a></div><div><div>Episodes</div><div data-controller="viewing-progression"
    data-viewing-progression-total-count-value="${total}"><span>?</span><span>/${total}</span></div></div>
  <a href="https://myanimelist.net/anime/60601">MAL</a></body></html>`;

test('current detail markup supplies episode totals and ISO premiere dates', () => {
  const metadata = parseLiveChartMetadata(detail(), url);
  assert.equal(metadata.title, 'Appraisal Skill Season 3');
  assert.equal(metadata.episodeCount, 12);
  assert.equal(metadata.premiereDate, '2026-09-27');
  assert.equal(metadata.malId, '60601');
  assert.equal(metadata.imageUrl, 'https://u.livechart.me/anime/12991/poster_image/example/small.jpg');
});

test('unknown and malformed episode totals are not guessed from viewing progress', () => {
  for (const total of ['', '?', '0', '-1', '12.5', '9007199254740992']) {
    assert.equal(parseLiveChartMetadata(detail(total), url).episodeCount, null, total);
  }
});

test('legacy detail text still supplies episode totals and premiere dates', () => {
  const metadata = parseLiveChartMetadata('<h1>Example</h1><div><div>Premiere</div><a>Jan 10, 2023</a></div><div>Episodes 0 / 120</div>', url);
  assert.equal(metadata.episodeCount, 120);
  assert.equal(metadata.premiereDate, '2023-01-10');
});

function progression(id, total, own = false) {
  return `<div data-controller="viewing-progression" data-viewing-progression-anime-id="${id}"
    ${own ? 'data-anime-details-target="viewingProgression"' : 'data-anime-item-target="viewingProgression"'}
    ${total === undefined ? '' : `data-viewing-progression-total-count-value="${total}"`}>
    <span>?</span><span>/${total ?? '–'}</span></div>`;
}

test('an unknown own total cannot inherit counts from related anime cards', () => {
  for (const [id, unrelatedTotal] of [['13232', 1], ['13571', 161]]) {
    const html = `<article data-anime-id="4003">${progression('4003', unrelatedTotal)}</article>
      <div data-controller="anime-details" data-anime-details-id="${id}">
      <div>Episodes${progression(id, undefined, true)}</div></div>`;
    const metadata = parseLiveChartMetadata(html, `https://www.livechart.me/anime/${id}`);
    assert.equal(metadata.episodeCount, null);
    assert.equal(metadata.episodeCountKnown, true);
  }
});

test('own totals win over earlier related widgets and the wrong anime identity is rejected', () => {
  const foreign = `<article data-anime-item-id="4003">${progression('4003', 161)}</article>`;
  const known = parseLiveChartMetadata(foreign + progression('12991', 12, true), url);
  assert.equal(known.episodeCount, 12);
  assert.equal(known.episodeCountKnown, true);
  const wrongPage = `<div data-controller="anime-details" data-anime-details-id="4003">
    <div>Episodes 161</div>${progression('4003', 161, true)}</div>`;
  const wrong = parseLiveChartMetadata(wrongPage, url);
  assert.equal(wrong.episodeCount, null);
  assert.equal(wrong.episodeCountKnown, false);
});

test('missing or malformed own totals do not fall back to recommendation text', () => {
  const related = '<article data-anime-id="4003"><div>Episodes 161</div></article>';
  for (const html of [related, progression('12991', 'invalid', true) + related,
    '<script>Episodes 161</script>', '<h1>Episodes and related titles</h1>']) {
    const metadata = parseLiveChartMetadata(html, url);
    assert.equal(metadata.episodeCount, null);
    assert.equal(metadata.episodeCountKnown, false);
  }
});

test('a successful fetch distinguishes an authoritative unknown total from missing metadata', async () => {
  const schedule = `<article data-release-schedule-release-schedule-id="1">
    <a href="/anime/12991/schedules/1">Released</a><a title="Simulcast: Subbed">Subbed</a>
    <span data-tracklist-json='{"de":["DE"]}'></span></article>`;
  const unknown = await fetchLiveChartEpisodes(`${url}/schedules`, {
    fetchHtml: async target => target.endsWith('/schedules') ? schedule : progression('12991', undefined, true)
  });
  assert.equal(unknown.episodeCount, null);
  assert.equal(unknown.episodeCountKnown, true);
  const missing = await fetchLiveChartEpisodes(`${url}/schedules`, {
    fetchHtml: async target => target.endsWith('/schedules') ? schedule : '<h1>Example</h1>'
  });
  assert.equal(missing.episodeCount, null);
  assert.equal(missing.episodeCountKnown, false);
});
