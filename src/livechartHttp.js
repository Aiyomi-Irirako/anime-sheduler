const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function liveChartId(value) {
  try {
    const url = new URL(value);
    if (!['livechart.me', 'www.livechart.me'].includes(url.hostname)) return '';
    return url.pathname.match(/^\/anime\/(\d+)(?:\/|$)/)?.[1] || '';
  } catch {
    return '';
  }
}

export function createLiveChartClient({ fetchImpl = (...args) => fetch(...args), delayMs = 6500,
  now = () => Date.now(), wait = sleep } = {}) {
  let queue = Promise.resolve();
  let lastRequest = null;
  let blockedUntil = 0;
  const cache = new Map();
  return (value, { ttlMs = 0 } = {}) => {
    const run = async () => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['livechart.me', 'www.livechart.me'].includes(url.hostname) ||
          url.port || url.username || url.password) throw new Error('Only HTTPS LiveChart URLs are allowed.');
      url.hostname = 'www.livechart.me';
      const key = url.toString();
      const cached = cache.get(key);
      if (ttlMs && cached && now() - cached.at < ttlMs) return cached.html;
      if (now() < blockedUntil) {
        const error = new Error('LiveChart requests paused after an access/rate-limit response.');
        error.status = 429;
        throw error;
      }
      if (lastRequest !== null) await wait(Math.max(0, delayMs - (now() - lastRequest)));
      lastRequest = now();
      const response = await fetchImpl(key, {
        headers: { 'user-agent': 'AnimeSheduler/1.7 (LiveChart schedule reader)' },
        signal: AbortSignal.timeout(30000), redirect: 'error'
      });
      if (!response.ok) {
        if ([403, 429].includes(response.status)) {
          const retry = response.headers.get('retry-after');
          const seconds = Number(retry);
          const until = retry && !Number.isFinite(seconds) ? Date.parse(retry) : now() + (seconds || 0) * 1000;
          blockedUntil = Math.max(now() + 24 * 3600000, Number.isFinite(until) ? until : 0);
        }
        const error = new Error(`LiveChart responded with HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        length += chunk.byteLength;
        if (length > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('LiveChart response exceeds 8 MB.');
        }
        chunks.push(Buffer.from(chunk));
      }
      const html = Buffer.concat(chunks).toString('utf8');
      if (/just a moment\.\.\.|<title>[^<]*access denied/i.test(html.slice(0, 8000))) {
        blockedUntil = now() + 24 * 3600000;
        const error = new Error('LiveChart access challenge; requests paused for 24 hours.');
        error.status = 403;
        throw error;
      }
      if (ttlMs) {
        cache.set(key, { at: now(), html });
        while (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      return html;
    };
    const task = queue.then(run);
    queue = task.catch(() => {});
    return task;
  };
}

export const fetchLiveChartHtml = createLiveChartClient();
