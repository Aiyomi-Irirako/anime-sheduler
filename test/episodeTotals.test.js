import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildAnnouncement } from "../src/discordBot.js";
import { formatEpisodeEntries, formatEpisodeRange, formatEpisodeLabel } from "../src/schedule.js";

const settings = { timeZone: "Europe/Berlin" };
const series = { title: "Example Season 2", episodeCount: 12, service: "Crunchyroll", streamingServiceId: "ABC123" };
const main = { kind: "main", episode: 5, dateTime: DateTime.fromISO("2026-09-18T17:00:00", { zone: settings.timeZone }) };
const german = { ...main, kind: "language", episode: 3, languageCode: "de", languageLabel: "German" };

function embedField(embed, name) {
  return embed.fields.find((field) => field.name === name || field.name.startsWith(`${name}\u2060`))?.value;
}

test("known episode totals are included in single and batch release labels", () => {
  assert.equal(formatEpisodeRange(main, 12), "Episode 05/12");
  assert.equal(formatEpisodeRange({ ...main, episodeEnd: 6 }, 12), "Episode 05-06/12");
  assert.equal(formatEpisodeRange({ ...main, episode: 1 }, 1), "Episode 01/1");
  assert.equal(formatEpisodeRange({ ...main, episode: 105 }, 120), "Episode 105/120");
  assert.equal(formatEpisodeLabel(series, german), "Episode 03/12 (German)");
});

test("unknown and invalid totals never produce a guessed denominator", () => {
  for (const episodeCount of [undefined, null, 0, -1, NaN, Infinity, 12.5, "12"]) {
    const entry = { ...series, episodeCount };
    assert.equal(formatEpisodeLabel(entry, main), "Episode 05");
    assert.equal(formatEpisodeLabel(entry, german), "Episode 03 (German)");
    assert.equal(formatEpisodeRange({ ...main, episodeEnd: 6 }, episodeCount), "Episode 05-06");
  }
  assert.equal(formatEpisodeLabel(series, { ...main, episode: null }), "Next episode");
  assert.equal(formatEpisodeLabel(series, { ...german, episode: null }), "Next episode (German)");
  assert.equal(formatEpisodeLabel(series, null), "Next episode");
});

test("release embeds include totals only in episode fields without changing headings or copy fields", () => {
  const embed = buildAnnouncement(series, main, settings).embeds[0].toJSON();
  assert.equal(embed.title, "Example Season 2 - Episode 05");
  assert.equal(embedField(embed, "Episode"), "Episode 05/12");
  assert.equal(embedField(embed, "Title"), "```text\nExample\n```");
  assert.equal(embedField(embed, "Service ID"), "```text\nABC123\n```");
  const batch = buildAnnouncement(series, { ...main, episodeEnd: 6 }, settings).embeds[0].toJSON();
  assert.equal(batch.title, "Example Season 2 - Episode 05-06");
  assert.equal(embedField(batch, "Episode"), "Episode 05-06/12");
});

test("combined original and dub announcements retain separate episode progress", () => {
  const release = { ...main, kind: "combined", releases: [main, german] };
  assert.deepEqual(formatEpisodeEntries(series, release).map((entry) => entry.text), ["Episode 05/12", "Episode 03/12 (German)"]);
  const embed = buildAnnouncement(series, release, settings).embeds[0].toJSON();
  assert.equal(embed.title, "Example Season 2 - Episode 05");
  assert.equal(embedField(embed, "Episode"), "Episode 05/12");
  assert.equal(embedField(embed, "Language versions"), "Episode 03/12 (German)");
});

test("dub-only announcements show totals without an original release", () => {
  const single = buildAnnouncement(series, german, settings).embeds[0].toJSON();
  assert.equal(single.title, "Example Season 2 - Episode 03 (German)");
  assert.equal(embedField(single, "Episode"), "Episode 03/12 (German)");
  assert.equal(embedField(single, "Language versions"), undefined);
  const english = { ...german, episode: 4, languageCode: "en", languageLabel: "English" };
  const combined = buildAnnouncement(series, { ...german, kind: "combined", releases: [german, english] }, settings).embeds[0].toJSON();
  assert.equal(embedField(combined, "Episode"), "Episode 03/12 (German)\nEpisode 04/12 (English)");
  assert.equal(combined.title, "Example Season 2 - Episode 03 (German)");
});

test("missing release times and unknown totals retain the existing fallback display", () => {
  const release = { ...main, dateTime: null, date: main.dateTime.startOf("day"), missingTime: true };
  const embed = buildAnnouncement(series, release, settings).embeds[0].toJSON();
  assert.equal(embedField(embed, "Episode"), "Episode 05/12");
  assert.equal(embedField(embed, "Time"), "time missing");
  const unknown = buildAnnouncement({ ...series, episodeCount: null }, main, settings).embeds[0].toJSON();
  assert.equal(unknown.title, "Example Season 2 - Episode 05");
  assert.equal(embedField(unknown, "Episode"), "Episode 05");
});

test("original announcements distinguish one episode from a batch", () => {
  assert.equal(buildAnnouncement(series, main, settings).embeds[0].data.description, "A new episode is available now.");
  assert.equal(buildAnnouncement(series, { ...main, episodeEnd: 6 }, settings).embeds[0].data.description,
    "New episodes are available now.");
});

test("dub announcements identify the language and released episodes", () => {
  assert.equal(buildAnnouncement(series, german, settings).embeds[0].data.description,
    "A new German dub episode is available now.");
  assert.equal(buildAnnouncement(series, { ...german, episodeEnd: 4 }, settings).embeds[0].data.description,
    "New German dub episodes are available now.");
  assert.equal(buildAnnouncement(series, { ...german, languageLabel: undefined }, settings).embeds[0].data.description,
    "A new German dub episode is available now.");
  assert.equal(buildAnnouncement(series, { ...german, languageLabel: undefined, languageCode: undefined }, settings).embeds[0].data.description,
    "A new dub episode is available now.");
});

test("combined announcements describe original and dub episodes instead of new versions", () => {
  const combined = { ...main, kind: "combined", releases: [main, german] };
  assert.equal(buildAnnouncement(series, combined, settings).embeds[0].data.description,
    "New original and German dub episodes are available now.");
  const english = { ...german, languageCode: "en", languageLabel: "English" };
  assert.equal(buildAnnouncement(series, { ...combined, releases: [german, english] }, settings).embeds[0].data.description,
    "New German dub and English dub episodes are available now.");
});

test("custom notes and the missing-time description remain unchanged", () => {
  const combined = { ...main, kind: "combined", releases: [main, german] };
  const missingTime = { ...combined, missingTime: true, dateTime: null, date: main.dateTime.startOf("day") };
  assert.equal(buildAnnouncement(series, missingTime, settings).embeds[0].data.description,
    "The exact release time is unknown, so this announcement uses the configured fallback time.");
  assert.equal(buildAnnouncement({ ...series, note: "Custom release note" }, combined, settings).embeds[0].data.description,
    "Custom release note");
  assert.equal(buildAnnouncement({ ...series, note: "Custom release note" }, missingTime, settings).embeds[0].data.description,
    "Custom release note");
});
