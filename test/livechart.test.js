import test from "node:test";
import assert from "node:assert/strict";
import { parseLiveChartEpisodes } from "../src/livechart.js";
import { prepareLiveMainSchedule } from "../src/livechartSync.js";
import { mergeLanguageTracks } from "../src/languages.js";

function article({ label, timestamp, title, languages, service, released = false }) {
  const tracks = JSON.stringify(languages).replaceAll('"', "&quot;");
  return `<article>
    <time data-timestamp="${timestamp}" data-label="${label}">${label}</time>
    <a title="${title}">${title}</a>
    <div data-tracklist-json="${tracks}"></div>
    <span>${service}</span>
    ${released ? "Released" : ""}
  </article>`;
}

test("prefers the German subtitle schedule over an earlier English release", () => {
  const html = [
    article({
      label: "EP24",
      timestamp: 1783812600,
      title: "Broadcast (Japan)",
      languages: { ja: ["JA"] },
      service: ""
    }),
    article({
      label: "EP24",
      timestamp: 1783819800,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], en: ["EN"] },
      service: "Crunchyroll"
    }),
    article({
      label: "EP24",
      timestamp: 1783906200,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], de: ["DE"], fr: ["FR"] },
      service: "Crunchyroll"
    })
  ].join("");

  const parsed = parseLiveChartEpisodes(html, {
    nowTimestamp: 1783800000,
    preferredLanguageCodes: ["de"]
  });

  assert.equal(parsed.nextEpisode, 24);
  assert.equal(parsed.mainReleaseTimestamp, 1783906200);
  assert.equal(parsed.service, "Crunchyroll");
});

test("parses episode ranges and keeps only German services", () => {
  const html = [
    article({
      label: "EP15\u201316",
      timestamp: 1784389500,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], de: ["DE"] },
      service: "aniverse Channel"
    }),
    article({
      label: "EP15\u201316",
      timestamp: 1784389500,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], fr: ["FR"] },
      service: "Animation Digital Network"
    }),
    article({
      label: "EP15\u201316",
      timestamp: 1784389500,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], en: ["EN"] },
      service: "Bilibili"
    })
  ].join("");

  const parsed = parseLiveChartEpisodes(html, {
    nowTimestamp: 1784300000,
    preferredLanguageCodes: ["de"]
  });

  assert.equal(parsed.nextEpisode, 15);
  assert.equal(parsed.episodeBatchSize, 2);
  assert.equal(parsed.mainReleaseTimestamp, 1784389500);
  assert.equal(parsed.service, "Aniverse");
});

test("does not fall back to a Japanese broadcast after the preferred streaming release finished", () => {
  const html = [
    article({
      label: "",
      timestamp: "",
      title: "Streaming: Dubbed, Subbed",
      languages: { de: ["DE"], en: ["EN"], ja: ["JA"] },
      service: "Netflix",
      released: true
    }),
    article({
      label: "EP3",
      timestamp: 1784471400,
      title: "Broadcast (Japan)",
      languages: { ja: ["JA"] },
      service: ""
    })
  ].join("");

  const german = parseLiveChartEpisodes(html, {
    nowTimestamp: 1784300000,
    preferredLanguageCodes: ["de"]
  });
  const automatic = parseLiveChartEpisodes(html, { nowTimestamp: 1784300000 });

  assert.equal(german.nextEpisode, null);
  assert.equal(german.mainFinished, true);
  assert.equal(german.preferredReleaseFinished, true);
  assert.equal(german.service, "Netflix");
  assert.equal(automatic.nextEpisode, 3);
  assert.equal(automatic.mainFinished, false);
});

test("automatic mode uses the earliest subtitle release without merging regional services", () => {
  const html = [
    article({
      label: "EP4",
      timestamp: 1785000000,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], en: ["EN"] },
      service: "Crunchyroll"
    }),
    article({
      label: "EP4",
      timestamp: 1785086400,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], de: ["DE"] },
      service: "aniverse Channel"
    }),
    article({
      label: "EP4",
      timestamp: 1785000000,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], fr: ["FR"] },
      service: "Animation Digital Network"
    })
  ].join("");

  const parsed = parseLiveChartEpisodes(html, { nowTimestamp: 1784900000 });

  assert.equal(parsed.mainReleaseTimestamp, 1785000000);
  assert.equal(parsed.service, "Crunchyroll");
});

test("falls back to the earliest subtitle release when the preferred language is unavailable", () => {
  const html = [
    article({
      label: "EP4",
      timestamp: 1785000000,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], en: ["EN"] },
      service: "Crunchyroll"
    }),
    article({
      label: "EP4",
      timestamp: 1785086400,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], de: ["DE"] },
      service: "aniverse Channel"
    })
  ].join("");

  const parsed = parseLiveChartEpisodes(html, {
    nowTimestamp: 1784900000,
    preferredLanguageCodes: ["fr"]
  });

  assert.equal(parsed.mainReleaseTimestamp, 1785000000);
  assert.equal(parsed.service, "Crunchyroll");
});

test("matches LiveChart Spanish schedule codes to the public Spanish option", () => {
  const html = [
    article({
      label: "EP4",
      timestamp: 1785000000,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], en: ["EN"] },
      service: "Crunchyroll"
    }),
    article({
      label: "EP4",
      timestamp: 1785086400,
      title: "Simulcast: Subbed",
      languages: { ja: ["JA"], "es-es": ["ES (ES)"] },
      service: "AnimeBox"
    })
  ].join("");

  const parsed = parseLiveChartEpisodes(html, {
    nowTimestamp: 1784900000,
    preferredLanguageCodes: ["es"]
  });

  assert.equal(parsed.mainReleaseTimestamp, 1785086400);
  assert.equal(parsed.service, "AnimeBox");
});

test("does not turn a missing LiveChart timestamp into the Unix epoch", () => {
  assert.deepEqual(
    prepareLiveMainSchedule(
      { mainReleaseTimestamp: null },
      { timeZone: "Europe/Berlin" }
    ),
    {}
  );
});

test("resets a previous language episode range when LiveChart returns one episode", () => {
  const [track] = mergeLanguageTracks(
    [{ code: "de", enabled: true, nextEpisode: 15, episodeBatchSize: 2 }],
    [{ code: "de", nextEpisode: 17, episodeBatchSize: 1 }],
    ["de"]
  );

  assert.equal(track.nextEpisode, 17);
  assert.equal(track.episodeBatchSize, 1);
});
