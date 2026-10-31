import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveChartClient } from '../src/livechartHttp.js';

const url = 'https://www.livechart.me/anime/13512/schedules';
const failure = code => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

test('a transient connection failure is retried once with the normal serial delay', async () => {
  let time = 1000000, calls = 0;
  const waits = [];
  const client = createLiveChartClient({ now: () => time,
    wait: async ms => { waits.push(ms); time += ms; },
    fetchImpl: async () => { calls += 1; if (calls === 1) throw failure('ECONNRESET'); return new Response('<html>Recovered</html>'); } });
  assert.equal(await client(url), '<html>Recovered</html>');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [6500]);
});

test('persistent connection failures stop after two attempts and retain a useful cause', async () => {
  let calls = 0;
  const client = createLiveChartClient({ delayMs: 0,
    fetchImpl: async () => { calls += 1; throw failure('UND_ERR_SOCKET'); } });
  await assert.rejects(client(url), /after one retry: fetch failed \(UND_ERR_SOCKET\)/);
  assert.equal(calls, 2);
});

test('access denials, rate limits and challenges are not retried or bypassed', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const client = createLiveChartClient({ delayMs: 0,
      fetchImpl: async () => { calls += 1; return new Response('', { status }); } });
    await assert.rejects(client(url), new RegExp(String(status)));
    await assert.rejects(client(url), /paused/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createLiveChartClient({ delayMs: 0,
    fetchImpl: async () => { calls += 1; return new Response('<title>Just a moment...</title>'); } });
  await assert.rejects(client(url), /challenge/);
  await assert.rejects(client(url), /paused/);
  assert.equal(calls, 1);
});

test('invalid certificate and redirect failures are never retried', async () => {
  for (const cause of [Object.assign(new Error('Certificate expired'), { code: 'CERT_HAS_EXPIRED' }),
    new Error('unexpected redirect')]) {
    let calls = 0;
    const client = createLiveChartClient({ delayMs: 0,
      fetchImpl: async () => { calls += 1; throw new TypeError('fetch failed', { cause }); } });
    await assert.rejects(client(url), /fetch failed/);
    assert.equal(calls, 1);
  }
});
