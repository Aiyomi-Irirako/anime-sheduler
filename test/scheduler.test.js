import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { checkDueAnnouncements } from "../src/scheduler.js";

test("posts only the delayed dub when LiveChart marks the main series finished", async () => {
  const now = DateTime.fromISO("2026-07-12T12:00:00", { zone: "Europe/Berlin" });
  const settings = {
    timeZone: "Europe/Berlin",
    reminderMinutes: 0,
    missingTimePostTime: "18:00",
    discordReleaseRoleIds: [],
    discordLanguageRoleIds: [],
    discordMissingTimeRoleIds: []
  };
  const initialSeries = {
    id: "wistoria-wand-and-sword",
    title: "Wistoria: Wand and Sword",
    service: "Crunchyroll",
    preferredService: "",
    scheduleLink: "https://www.livechart.me/anime/12345/schedules",
    imageUrl: "",
    note: "",
    enabled: true,
    status: "airing",
    weekly: true,
    releaseDay: "sunday",
    releaseTime: "12:00",
    nextDate: "2026-07-12",
    nextEpisode: 12,
    episodeBatchSize: 1,
    episodeCount: 12,
    lastPostedKey: "wistoria-wand-and-sword:main:12:release-time:2026-04-01T12:00:00.000+02:00",
    languageTracks: [
      {
        code: "de",
        label: "German",
        enabled: true,
        available: true,
        weekly: true,
        releaseDay: "sunday",
        releaseTime: "12:00",
        nextDate: "2026-07-12",
        nextEpisode: 12,
        episodeBatchSize: 1,
        lastPostedKey: ""
      }
    ]
  };
  let currentSeries = structuredClone(initialSeries);
  const messages = [];
  const postLogs = [];
  const store = {
    snapshot() {
      return { settings: structuredClone(settings), series: [structuredClone(currentSeries)] };
    },
    getSeries(id) {
      return id === currentSeries.id ? currentSeries : null;
    },
    async replaceSeries(id, next) {
      assert.equal(id, currentSeries.id);
      currentSeries = next;
      return next;
    },
    async addPostLog(entry) {
      postLogs.push(entry);
    }
  };
  const discord = {
    enabled: true,
    ready: true,
    async post(message) {
      messages.push(message);
    }
  };
  const syncSeries = async () => {
    currentSeries = {
      ...currentSeries,
      status: "finished",
      nextEpisode: null
    };
    return {
      changed: true,
      updated: currentSeries,
      live: { mainFinished: true }
    };
  };

  const result = await checkDueAnnouncements(store, discord, { now, syncSeries });

  assert.equal(result.posted, 1);
  assert.equal(messages.length, 1);
  const fields = Object.fromEntries(messages[0].embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Version, "German");
  assert.equal(fields.Episode, "Episode 12 (German)");
  assert.doesNotMatch(JSON.stringify(messages[0]), /Original/);
  assert.equal(postLogs[0].type, "auto-language");
});

test("preserves an unposted final original episode when LiveChart just finished", async () => {
  const now = DateTime.fromISO("2026-07-12T12:00:00", { zone: "Europe/Berlin" });
  const settings = {
    timeZone: "Europe/Berlin",
    reminderMinutes: 0,
    missingTimePostTime: "18:00",
    discordReleaseRoleIds: [],
    discordLanguageRoleIds: [],
    discordMissingTimeRoleIds: []
  };
  let currentSeries = {
    id: "final-episode",
    title: "Final Episode",
    service: "Crunchyroll",
    preferredService: "",
    scheduleLink: "https://www.livechart.me/anime/54321/schedules",
    imageUrl: "",
    note: "",
    enabled: true,
    status: "airing",
    weekly: true,
    releaseDay: "sunday",
    releaseTime: "12:00",
    nextDate: "2026-07-12",
    nextEpisode: 12,
    episodeBatchSize: 1,
    episodeCount: 12,
    lastPostedKey: "final-episode:main:11:release-time:2026-07-05T12:00:00.000+02:00",
    languageTracks: []
  };
  const messages = [];
  const store = {
    snapshot() {
      return { settings: structuredClone(settings), series: [structuredClone(currentSeries)] };
    },
    getSeries(id) {
      return id === currentSeries.id ? currentSeries : null;
    },
    async replaceSeries(id, next) {
      assert.equal(id, currentSeries.id);
      currentSeries = next;
      return next;
    },
    async addPostLog() {}
  };
  const discord = {
    enabled: true,
    ready: true,
    async post(message) {
      messages.push(message);
    }
  };
  const syncSeries = async () => {
    currentSeries = { ...currentSeries, status: "finished", nextEpisode: null };
    return { changed: true, updated: currentSeries, live: { mainFinished: true } };
  };

  const result = await checkDueAnnouncements(store, discord, { now, syncSeries });

  assert.equal(result.posted, 1);
  const fields = Object.fromEntries(messages[0].embeds[0].data.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.Version, "Original");
  assert.equal(fields.Episode, "Episode 12");
});

test("drops an unpreferred Japanese broadcast after a preferred batch release finished", async () => {
  const now = DateTime.fromISO("2026-07-12T16:30:00", { zone: "Europe/Berlin" });
  const settings = {
    timeZone: "Europe/Berlin",
    reminderMinutes: 0,
    missingTimePostTime: "18:00",
    discordReleaseRoleIds: [],
    discordLanguageRoleIds: [],
    discordMissingTimeRoleIds: []
  };
  let currentSeries = {
    id: "baki-dou",
    title: "BAKI-DOU: The Invincible Samurai",
    service: "Netflix",
    preferredService: "",
    scheduleLink: "https://www.livechart.me/anime/12621/schedules",
    imageUrl: "",
    note: "",
    enabled: true,
    status: "airing",
    weekly: true,
    releaseDay: "sunday",
    releaseTime: "16:30",
    nextDate: "2026-07-12",
    nextEpisode: 3,
    episodeBatchSize: 1,
    episodeCount: 25,
    lastPostedKey: "baki-dou:main:2:release-time:2026-07-05T16:30:00.000+02:00",
    languageTracks: []
  };
  const messages = [];
  const store = {
    snapshot() {
      return { settings: structuredClone(settings), series: [structuredClone(currentSeries)] };
    },
    getSeries(id) {
      return id === currentSeries.id ? currentSeries : null;
    },
    async replaceSeries(id, next) {
      assert.equal(id, currentSeries.id);
      currentSeries = next;
      return next;
    },
    async addPostLog() {}
  };
  const discord = {
    enabled: true,
    ready: true,
    async post(message) {
      messages.push(message);
    }
  };
  const syncSeries = async () => {
    currentSeries = {
      ...currentSeries,
      status: "finished",
      enabled: false,
      nextEpisode: null,
      nextDate: ""
    };
    return {
      changed: true,
      updated: currentSeries,
      live: { mainFinished: true, preferredReleaseFinished: true }
    };
  };

  const result = await checkDueAnnouncements(store, discord, { now, syncSeries });

  assert.equal(result.posted, 0);
  assert.equal(messages.length, 0);
});
