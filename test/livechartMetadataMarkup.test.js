import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveChartMetadata } from '../src/livechart.js';

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
