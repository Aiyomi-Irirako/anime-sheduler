import { cleanString } from "./utils.js";

const SERVICE_ALIASES = new Map([
  ["animation digital network", "ADN"],
  ["aniverse channel", "Aniverse"],
  ["amazon prime video", "Prime Video"]
]);

const SERVICE_STYLES = new Map([
  ["crunchyroll", { bg: "#f47521", border: "#f47521", ink: "#ffffff" }],
  ["netflix", { bg: "#e50914", border: "#e50914", ink: "#ffffff" }],
  ["prime video", { bg: "#00a8e1", border: "#00a8e1", ink: "#03131d" }],
  ["youtube", { bg: "#ff0000", border: "#ff0000", ink: "#ffffff" }],
  ["adn", { bg: "#00a3e0", border: "#00a3e0", ink: "#ffffff" }],
  ["aniverse", { bg: "linear-gradient(135deg, #4b2cff 0%, #ff3d9a 100%)", border: "#ff3d9a", ink: "#ffffff" }],
  ["hidive", { bg: "#00aeef", border: "#00aeef", ink: "#06151d" }],
  ["disney+", { bg: "#113ccf", border: "#113ccf", ink: "#ffffff" }],
  ["hulu", { bg: "#1ce783", border: "#1ce783", ink: "#062817" }],
  ["bilibili", { bg: "#00aeec", border: "#00aeec", ink: "#ffffff" }],
  ["max", { bg: "#5f2eea", border: "#5f2eea", ink: "#ffffff" }],
  ["apple tv+", { bg: "#111111", border: "#111111", ink: "#ffffff" }]
]);

export function normalizeServiceName(value) {
  const service = cleanString(value);
  if (!service) return "";
  return SERVICE_ALIASES.get(service.toLowerCase()) || service;
}

export function splitServiceNames(value) {
  return cleanString(value)
    .split(",")
    .map((service) => normalizeServiceName(service))
    .filter(Boolean);
}

export function normalizeServiceList(value) {
  return splitServiceNames(value).join(",");
}

export function normalizePreferredService(value, serviceList = "") {
  const preferred = normalizeServiceName(value);
  if (!preferred) return "";

  const match = splitServiceNames(serviceList).find((service) => service.toLowerCase() === preferred.toLowerCase());
  return match || "";
}

export function pickPreferredService(serviceList = "", preferredService = "") {
  const services = splitServiceNames(serviceList);
  if (!services.length) return "";

  const preferred = normalizePreferredService(preferredService, serviceList);
  if (preferred) return preferred;

  return services.find((service) => service.toLowerCase() !== "youtube") || services[0];
}

export function serviceStyle(service) {
  const key = normalizeServiceName(service).toLowerCase();
  return SERVICE_STYLES.get(key) || { bg: "var(--surface-soft)", border: "var(--line)", ink: "var(--ink)" };
}
