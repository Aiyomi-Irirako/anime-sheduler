import { parse } from "csv-parse/sync";
import { DateTime } from "luxon";
import { parseReleasePattern } from "./schedule.js";
import { cleanString, normalizeDate, parseBoolean, parseInteger } from "./utils.js";

function rowValue(row, key) {
  const match = Object.keys(row).find((field) => field.trim().toLowerCase() === key);
  return match ? row[match] : "";
}

function firstRowValue(row, keys) {
  for (const key of keys) {
    const value = cleanString(rowValue(row, key));
    if (value) return value;
  }
  return "";
}

function parseEpisodeCount(value) {
  const text = cleanString(value);
  if (!text) return null;
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return null;
  return Math.trunc(number);
}

function detectDelimiter(csvText) {
  const firstLine = cleanString(csvText).split(/\r?\n/, 1)[0] || "";
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

function normalizePremiere(value) {
  const text = cleanString(value);
  if (!text) return "";
  const iso = normalizeDate(text);
  if (iso) return iso;
  const parsed = DateTime.fromISO(text);
  return parsed.isValid ? parsed.toISODate() : "";
}

export function parseSeriesCsv(csvText) {
  const rows = parse(csvText, {
    bom: true,
    columns: true,
    delimiter: detectDelimiter(csvText),
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true
  });

  return rows
    .map((row) => {
      const title = cleanString(rowValue(row, "title"));
      if (!title) return null;

      const rldate = cleanString(rowValue(row, "rldate"));
      const release = parseReleasePattern(rldate);
      const rawNextEpisode = cleanString(rowValue(row, "nextep"));
      const nextEpisode = parseInteger(rawNextEpisode);
      const dubNextEpisode = parseInteger(
        firstRowValue(row, ["dub_next_ep", "dubnextep", "german_ep", "german_next_ep", "de_ep"])
      );
      const dubbed = parseBoolean(rowValue(row, "dubbed")) || dubNextEpisode !== null;
      const isFinished = /^finished$/i.test(rawNextEpisode) || release.status === "finished";
      const premiereDate = normalizePremiere(rowValue(row, "premiere"));

      const status = isFinished
        ? "finished"
        : release.status === "airing"
          ? "airing"
          : premiereDate
            ? "planned"
            : release.status || "unknown";

      return {
        title,
        service: cleanString(rowValue(row, "service")),
        premiereDate,
        releaseDay: release.releaseDay || "",
        releaseTime: release.releaseTime || "",
        rawRelease: release.rawRelease || rldate,
        nextDate: "",
        nextEpisode,
        episodeCount: parseEpisodeCount(rowValue(row, "epcount")),
        preferredService: firstRowValue(row, ["preferred_service", "preferredservice", "service_preference", "post_service"]),
        scheduleLink: cleanString(rowValue(row, "schedulelink")),
        imageUrl: firstRowValue(row, ["imageurl", "image_url", "poster", "posterurl", "poster_url", "cover", "cover_url"]),
        malId: cleanString(rowValue(row, "malid")),
        tvdbId: cleanString(rowValue(row, "tvdb_id")),
        tmdbId: cleanString(rowValue(row, "tmdb_id_from_tmdb")) || cleanString(rowValue(row, "tmdb_id_from_tvdb")),
        dubbed,
        dubNextEpisode,
        serviceExt: cleanString(rowValue(row, "service_ext")),
        note: cleanString(rowValue(row, "note")),
        changelog: cleanString(rowValue(row, "changelog")),
        status,
        enabled: !isFinished,
        weekly: true
      };
    })
    .filter(Boolean);
}
