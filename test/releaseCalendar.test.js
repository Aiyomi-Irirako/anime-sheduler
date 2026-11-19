import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { load } from "cheerio";
import { Settings } from "luxon";
import { createWebApp } from "../src/web.js";

test("the calendar uses the configured local dates and keeps the Discord summary period independent", async (t) => {
  const originalNow = Settings.now;
  Settings.now = () => Date.parse("2026-11-19T23:30:00Z");
  t.after(() => { Settings.now = originalNow; });

  const data = {
    settings: { timeZone: "Europe/Berlin", lookaheadDays: 3 },
    series: [
      { id: "past", title: "Previous release", enabled: true, nextDate: "2026-11-19", releaseTime: "23:55", nextEpisode: 1 },
      { id: "today", title: "Today's original", enabled: true, nextDate: "2026-11-20", releaseTime: "", nextEpisode: 3 },
      { id: "tomorrow", title: "Tomorrow's original", enabled: true, nextDate: "2026-11-21", releaseTime: "18:30", nextEpisode: 5 },
      { id: "dub", title: "Later dub", enabled: true, status: "finished", episodeCount: 9, languageTracks: [
        { code: "de", enabled: true, nextDate: "2026-11-22", releaseTime: "23:55", nextEpisode: 9 }
      ] },
      { id: "outside", title: "After the period", enabled: true, nextDate: "2026-11-23", releaseTime: "", nextEpisode: 7 }
    ]
  };
  const discord = { enabled: false, post() { assert.fail("Loading the calendar must not post to Discord"); } };
  const app = createWebApp({ snapshot: () => data }, discord);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const headers = process.env.WEB_PASSWORD ? {
    Authorization: `Basic ${Buffer.from(`${process.env.WEB_USER || "admin"}:${process.env.WEB_PASSWORD}`).toString("base64")}`
  } : {};
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    assert.equal(response.status, 200);
    return response;
  };

  const calendar = load(await (await get("/calendar")).text());
  assert.deepEqual(calendar(".upcoming-day-header span").map((_, date) => calendar(date).text()).get(),
    ["20 Nov 2026", "21 Nov 2026", "22 Nov 2026"]);
  assert.deepEqual(calendar(".upcoming-list a").map((_, link) => calendar(link).attr("href")).get(),
    ["/series/today", "/series/tomorrow", "/series/dub"]);
  assert.match(calendar(".upcoming-list").first().text(), /time missing/);
  assert.match(calendar(".upcoming-list").last().text(), /Episode 09\/9 \(German\)/);
  assert.match(calendar(".upcoming-list").last().text(), /23:55/);

  const dashboard = load(await (await get("/")).text());
  assert.equal(dashboard("nav a[href='/calendar']").text(), "Calendar");
  assert.equal(dashboard(".upcoming-list a[href='/series/dub']").length, 0);
  const { upcoming } = await (await get("/api/upcoming")).json();
  assert.deepEqual(upcoming.map(({ id }) => id), ["today", "tomorrow"]);

  data.settings.lookaheadDays = 1;
  const shorter = load(await (await get("/calendar")).text());
  assert.deepEqual(shorter(".upcoming-list a").map((_, link) => shorter(link).attr("href")).get(),
    ["/series/today"]);
});
