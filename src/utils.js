import crypto from "node:crypto";

export function cleanString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export function parseInteger(value) {
  const text = cleanString(value);
  if (!text) return null;
  const number = Number.parseInt(text, 10);
  return Number.isFinite(number) ? number : null;
}

export function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  const text = cleanString(value).toLowerCase();
  return ["1", "true", "yes", "ja", "on"].includes(text);
}

export function padEpisode(value) {
  const number = parseInteger(value);
  if (number === null) return "";
  return String(number).padStart(2, "0");
}

export function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function createId(seed = "series") {
  const base = slugify(seed) || "series";
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

export function sourceKey(series) {
  return `${cleanString(series.title).toLowerCase()}|${cleanString(series.service).toLowerCase()}`;
}

export function escapeHtml(value) {
  return cleanString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeDate(value) {
  const text = cleanString(value);
  if (!text) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function normalizeTime(value) {
  const text = cleanString(value);
  if (!text) return "";
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeHttpUrl(value) {
  const text = cleanString(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function toFormBoolean(value) {
  return value ? "checked" : "";
}
