import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { DEFAULT_TIME_ZONE } from "./constants.js";
import { parseSeriesCsv } from "./csvImport.js";
import {
  cleanString,
  createId,
  normalizeDate,
  normalizeEpisodeBatchSize,
  normalizeHttpUrl,
  normalizeTime,
  parseBoolean,
  parseInteger
} from "./utils.js";
import { isSeriesComplete, normalizeReleaseDay } from "./schedule.js";
import {
  normalizeEnabledLanguageCodes,
  normalizeLanguageTracks
} from "./languages.js";
import { normalizePreferredService, normalizeServiceList } from "./services.js";

function normalizeDiscordChannelIds(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const ids = [];

  for (const item of raw) {
    const id = cleanString(item);
    if (!/^\d{10,30}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function normalizeDiscordRoleIds(value) {
  return normalizeDiscordChannelIds(value);
}

const DEFAULT_DATA = {
  settings: {
    timeZone: process.env.TIME_ZONE || DEFAULT_TIME_ZONE,
    discordChannelId: process.env.DISCORD_CHANNEL_ID || "",
    discordChannelIds: normalizeDiscordChannelIds(process.env.DISCORD_CHANNEL_ID),
    discordReleaseRoleIds: normalizeDiscordRoleIds(process.env.DISCORD_RELEASE_ROLE_ID),
    discordLanguageRoleIds: normalizeDiscordRoleIds(process.env.DISCORD_LANGUAGE_ROLE_ID),
    discordMissingTimeRoleIds: normalizeDiscordRoleIds(process.env.DISCORD_MISSING_TIME_ROLE_ID),
    reminderMinutes: Number.parseInt(process.env.REMINDER_MINUTES || "0", 10),
    lookaheadDays: 14,
    schedulerIntervalSeconds: 60,
    summaryLimit: 12,
    missingTimePostTime: normalizeTime(process.env.MISSING_TIME_POST_TIME) || "18:00",
    liveChartSyncEnabled: true,
    liveChartSyncHour: 5,
    enabledLanguageCodes: ["de"],
    lastLiveChartSyncAt: "",
    lastLiveChartSyncSummary: ""
  },
  series: [],
  posts: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoreData(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const settingsSource = source.settings && typeof source.settings === "object" && !Array.isArray(source.settings) ? source.settings : {};
  const data = {
    ...clone(DEFAULT_DATA),
    ...source
  };

  data.settings = { ...clone(DEFAULT_DATA.settings), ...settingsSource };
  data.settings.discordChannelIds = normalizeDiscordChannelIds(
    data.settings.discordChannelIds?.length
      ? data.settings.discordChannelIds
      : data.settings.discordChannelId || process.env.DISCORD_CHANNEL_ID
  );
  data.settings.discordChannelId = data.settings.discordChannelIds[0] || data.settings.discordChannelId || "";
  data.settings.discordReleaseRoleIds = normalizeDiscordRoleIds(
    data.settings.discordReleaseRoleIds?.length
      ? data.settings.discordReleaseRoleIds
      : data.settings.discordReleaseRoleId || process.env.DISCORD_RELEASE_ROLE_ID
  );
  data.settings.discordLanguageRoleIds = normalizeDiscordRoleIds(
    data.settings.discordLanguageRoleIds?.length
      ? data.settings.discordLanguageRoleIds
      : data.settings.discordLanguageRoleId || process.env.DISCORD_LANGUAGE_ROLE_ID
  );
  data.settings.discordMissingTimeRoleIds = normalizeDiscordRoleIds(
    data.settings.discordMissingTimeRoleIds?.length
      ? data.settings.discordMissingTimeRoleIds
      : data.settings.discordMissingTimeRoleId || process.env.DISCORD_MISSING_TIME_ROLE_ID
  );
  data.series = Array.isArray(data.series) ? data.series.map((item) => normalizeSeries(item, item)) : [];
  data.posts = Array.isArray(data.posts) ? data.posts : [];

  return data;
}

function seriesImportKey(series) {
  const scheduleLink = cleanString(series.scheduleLink).toLowerCase().replace(/\/+$/, "");
  if (scheduleLink) return `schedule:${scheduleLink}`;
  return `title-service:${cleanString(series.title).toLowerCase()}|${normalizeServiceList(series.service).toLowerCase()}`;
}

function normalizeSeries(input, existing = {}) {
  const now = DateTime.now().toISO();
  const nextEpisode = parseInteger(input.nextEpisode);
  const episodeBatchSize =
    input.episodeBatchSize === undefined && existing.episodeBatchSize !== undefined
      ? normalizeEpisodeBatchSize(existing.episodeBatchSize)
      : normalizeEpisodeBatchSize(input.episodeBatchSize);
  const episodeCount = parseInteger(input.episodeCount);
  const existingEpisodeCount = parseInteger(existing.episodeCount);
  const existingEpisodeCountUpdatedAt = cleanString(input.episodeCountUpdatedAt || existing.episodeCountUpdatedAt);
  const episodeCountUpdatedAt =
    episodeCount !== null && episodeCount !== existingEpisodeCount
      ? now
      : episodeCount !== null
        ? existingEpisodeCountUpdatedAt || now
        : "";
  const service = normalizeServiceList(input.service);
  const preferredService = normalizePreferredService(
    input.preferredService === undefined ? existing.preferredService : input.preferredService,
    service
  );
  const dubNextEpisode =
    input.dubNextEpisode === undefined && existing.dubNextEpisode !== undefined
      ? parseInteger(existing.dubNextEpisode)
      : parseInteger(input.dubNextEpisode);
  const existingTracks = Array.isArray(existing.languageTracks) ? existing.languageTracks : [];
  const inputTracks = Array.isArray(input.languageTracks) ? input.languageTracks : existingTracks;
  const hasGermanTrack = inputTracks.some((track) => cleanString(track.code).toLowerCase().replaceAll("_", "-") === "de");
  const legacyGermanEnabled =
    input.dubbed === undefined && existing.dubbed !== undefined ? parseBoolean(existing.dubbed) : parseBoolean(input.dubbed);
  const legacyGermanTrack =
    !hasGermanTrack && (legacyGermanEnabled || dubNextEpisode !== null)
      ? {
          code: "de",
          label: "German",
          enabled: legacyGermanEnabled,
          available: true,
          nextEpisode: dubNextEpisode,
          source: "legacy"
        }
      : null;
  const languageTracks = normalizeLanguageTracks(
    legacyGermanTrack ? [...inputTracks, legacyGermanTrack] : inputTracks,
    existingTracks
  );
  const germanTrack = languageTracks.find((track) => track.code === "de");

  const normalized = {
    id: existing.id || input.id || createId(input.title),
    title: cleanString(input.title),
    service,
    preferredService,
    premiereDate: normalizeDate(input.premiereDate),
    releaseDay: normalizeReleaseDay(input.releaseDay),
    releaseTime: normalizeTime(input.releaseTime),
    rawRelease: cleanString(input.rawRelease),
    nextDate: normalizeDate(input.nextDate),
    nextEpisode,
    episodeBatchSize,
    episodeCount,
    scheduleLink: cleanString(input.scheduleLink),
    imageUrl: normalizeHttpUrl(input.imageUrl),
    malId: cleanString(input.malId),
    tvdbId: cleanString(input.tvdbId),
    tmdbId: cleanString(input.tmdbId),
    languageTracks,
    dubbed: Boolean(germanTrack?.enabled),
    dubNextEpisode: germanTrack?.nextEpisode ?? null,
    serviceExt: cleanString(input.serviceExt),
    note: cleanString(input.note),
    changelog: cleanString(input.changelog),
    status: cleanString(input.status) || "unknown",
    enabled: input.enabled === undefined ? true : parseBoolean(input.enabled),
    weekly: input.weekly === undefined ? true : parseBoolean(input.weekly),
    lastPostedKey: cleanString(input.lastPostedKey || existing.lastPostedKey),
    lastPostedAt: cleanString(input.lastPostedAt || existing.lastPostedAt),
    episodeCountUpdatedAt,
    finishedAt: cleanString(input.finishedAt || existing.finishedAt),
    lastLiveChartCheckedAt: cleanString(input.lastLiveChartCheckedAt || existing.lastLiveChartCheckedAt),
    createdAt: existing.createdAt || input.createdAt || now,
    updatedAt: now
  };

  normalized.finishedAt = isSeriesComplete(normalized) ? normalized.finishedAt || now : "";
  return normalized;
}

function mergeImportedSeries(existing, incoming, options = {}) {
  const overwriteSchedule = Boolean(options.overwriteSchedule);
  const schedulePatch = overwriteSchedule
    ? {
        releaseDay: incoming.releaseDay,
        releaseTime: incoming.releaseTime,
        nextEpisode: incoming.nextEpisode,
        episodeBatchSize: incoming.episodeBatchSize,
        episodeCount: incoming.episodeCount,
        dubNextEpisode: incoming.dubNextEpisode,
        status: incoming.status,
        enabled: incoming.enabled,
        weekly: incoming.weekly
      }
    : {};

  return normalizeSeries(
    {
      ...existing,
      title: incoming.title || existing.title,
      service: incoming.service || existing.service,
      preferredService: incoming.preferredService || existing.preferredService,
      premiereDate: incoming.premiereDate || existing.premiereDate,
      rawRelease: incoming.rawRelease || existing.rawRelease,
      scheduleLink: incoming.scheduleLink || existing.scheduleLink,
      imageUrl: incoming.imageUrl || existing.imageUrl,
      malId: incoming.malId || existing.malId,
      tvdbId: incoming.tvdbId || existing.tvdbId,
      tmdbId: incoming.tmdbId || existing.tmdbId,
      dubbed: incoming.dubbed,
      serviceExt: incoming.serviceExt || existing.serviceExt,
      note: incoming.note || existing.note,
      changelog: incoming.changelog || existing.changelog,
      ...schedulePatch
    },
    existing
  );
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = normalizeStoreData(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = clone(DEFAULT_DATA);
      await this.save();
    }
  }

  snapshot() {
    return clone(this.data);
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  getSettings() {
    return this.data.settings;
  }

  async updateSettings(patch) {
    const discordChannelIds = normalizeDiscordChannelIds(patch.discordChannelIds);
    this.data.settings = {
      ...this.data.settings,
      timeZone: cleanString(patch.timeZone) || this.data.settings.timeZone,
      discordChannelIds,
      discordChannelId: discordChannelIds[0] || "",
      discordReleaseRoleIds: normalizeDiscordRoleIds(patch.discordReleaseRoleIds),
      discordLanguageRoleIds: normalizeDiscordRoleIds(patch.discordLanguageRoleIds),
      discordMissingTimeRoleIds: normalizeDiscordRoleIds(patch.discordMissingTimeRoleIds),
      reminderMinutes: Math.max(0, parseInteger(patch.reminderMinutes) ?? 0),
      lookaheadDays: Math.max(1, parseInteger(patch.lookaheadDays) ?? 14),
      schedulerIntervalSeconds: Math.max(30, parseInteger(patch.schedulerIntervalSeconds) ?? 60),
      summaryLimit: Math.max(1, parseInteger(patch.summaryLimit) ?? 12),
      missingTimePostTime: normalizeTime(patch.missingTimePostTime) || this.data.settings.missingTimePostTime || "18:00",
      liveChartSyncEnabled: parseBoolean(patch.liveChartSyncEnabled),
      liveChartSyncHour: Math.min(23, Math.max(0, parseInteger(patch.liveChartSyncHour) ?? 5)),
      enabledLanguageCodes: normalizeEnabledLanguageCodes(patch.enabledLanguageCodes)
    };
    await this.save();
  }

  async markLiveChartSync(result) {
    this.data.settings.lastLiveChartSyncAt = DateTime.now().toISO();
    this.data.settings.lastLiveChartSyncSummary = cleanString(result.summary);
    await this.save();
  }

  listSeries() {
    return this.data.series;
  }

  getSeries(id) {
    return this.data.series.find((series) => series.id === id) || null;
  }

  async upsertSeries(input) {
    const existing = input.id ? this.getSeries(input.id) : null;
    const normalized = normalizeSeries(input, existing || {});

    if (existing) {
      const index = this.data.series.findIndex((series) => series.id === existing.id);
      this.data.series[index] = normalized;
    } else {
      this.data.series.push(normalized);
    }

    await this.save();
    return normalized;
  }

  async replaceSeries(id, nextSeries) {
    const index = this.data.series.findIndex((series) => series.id === id);
    if (index === -1) return null;
    this.data.series[index] = normalizeSeries(nextSeries, this.data.series[index]);
    await this.save();
    return this.data.series[index];
  }

  async deleteSeries(id) {
    const before = this.data.series.length;
    this.data.series = this.data.series.filter((series) => series.id !== id);
    const deleted = before - this.data.series.length;
    if (deleted) await this.save();
    return deleted;
  }

  async importCsv(csvText, options = {}) {
    const incoming = parseSeriesCsv(csvText);
    const existingByKey = new Map(this.data.series.map((series) => [seriesImportKey(series), series]));
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const series of incoming) {
      const key = seriesImportKey(series);
      const existing = existingByKey.get(key);

      if (existing && !options.updateExisting) {
        skipped += 1;
        continue;
      }

      if (existing) {
        const index = this.data.series.findIndex((item) => item.id === existing.id);
        this.data.series[index] = mergeImportedSeries(existing, series, options);
        updated += 1;
      } else {
        const normalized = normalizeSeries(series);
        this.data.series.push(normalized);
        existingByKey.set(key, normalized);
        created += 1;
      }
    }

    await this.save();
    return { total: incoming.length, created, updated, skipped };
  }

  async replaceData(input) {
    this.data = normalizeStoreData(input);
    await this.save();
    return {
      series: this.data.series.length,
      posts: this.data.posts.length
    };
  }

  async addPostLog(entry) {
    this.data.posts.unshift({
      id: createId("post"),
      createdAt: DateTime.now().toISO(),
      ...entry
    });
    this.data.posts = this.data.posts.slice(0, 200);
    await this.save();
  }
}

export function createStore(filePath = path.resolve("data", "db.json")) {
  return new Store(filePath);
}
