import { normalizeLanguageCode } from './languages.js';
import { normalizeServiceName, splitServiceNames } from './services.js';
import { cleanString } from './utils.js';

const streaming = /^(?:Streaming|Simulcast)(?:\s*\([^)]*\))?(?::\s*.+)?$/i;
const key = value => normalizeServiceName(value).toLowerCase();
const unique = values => {
  const services = new Map();
  for (const value of values) {
    const name = normalizeServiceName(value);
    if (name && !services.has(key(name))) services.set(key(name), name);
  }
  return [...services.values()];
};

export function collectLiveChartServiceEvidence(rows, preferredCodes = [], isUsable = () => true) {
  const codes = new Set((Array.isArray(preferredCodes) ? preferredCodes : [preferredCodes])
    .map(normalizeLanguageCode).filter(Boolean));
  const active = [], matching = [], completed = [];
  for (const row of rows || []) {
    if (!streaming.test(row.title)) continue;
    const services = Array.isArray(row.services) ? row.services : [];
    const matches = (row.isSubbed && (row.subtitleCodes || []).some(code => codes.has(code))) ||
      (row.isDub && (row.audioCodes || []).some(code => codes.has(code)));
    if (!row.isReleased) {
      active.push(...services);
      if (matches && isUsable(row)) matching.push(...services);
    } else if (matches && !/^Release ended\b/i.test(cleanString(row.dateLabel))) {
      completed.push(...services);
    }
  }
  return { active: unique(active), matching: unique(matching), completed: unique(completed) };
}

function legacyServiceNames(value) {
  let entries;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = Object.entries(parsed);
  } catch {
    // Older CSV exports use a small Python-style quoted mapping. Accept only
    // literal string pairs; never evaluate expressions or partially parse input.
    const text = cleanString(value);
    if (!/^\{[\s\S]*\}$/.test(text)) return [];
    const contents = text.slice(1, -1);
    const pair = /\s*(['"])([^'"\\\r\n]*)\1\s*:\s*(['"])([^'"\\\r\n]*)\3\s*(,|$)/y;
    entries = [];
    let position = 0;
    while (position < contents.length) {
      pair.lastIndex = position;
      const match = pair.exec(contents);
      if (!match) {
        if (contents.slice(position).trim()) return [];
        break;
      }
      entries.push([match[2], match[4]]);
      position = pair.lastIndex;
    }
  }
  return (entries || []).filter(([, type]) => typeof type === 'string' &&
    /^(?:Sub|Dub)(?:\s*(?:[,&/+|]|\band\b)\s*(?:Sub|Dub))*$/i.test(type.trim()))
    .map(([name]) => name);
}

export function reconcileLiveChartServices(series, live = {}) {
  const evidence = live.serviceEvidence;
  if (!evidence || !['active', 'matching', 'completed'].every(field => Array.isArray(evidence[field]))) {
    return live.service || '';
  }
  const active = new Map(unique(evidence.active).map(name => [key(name), name]));
  const matching = new Set(unique(evidence.matching).map(key));
  const completed = new Set(unique(evidence.completed).map(key));
  const known = unique([...splitServiceNames(series?.service), ...legacyServiceNames(series?.serviceExt)]);
  const retained = known.filter(name => active.has(key(name)) &&
    (!completed.has(key(name)) || matching.has(key(name))))
    .map(name => active.get(key(name)));
  return unique([...splitServiceNames(live.service), ...evidence.matching, ...retained]).join(',');
}
