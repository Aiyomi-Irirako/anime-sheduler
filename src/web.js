import express from "express";
import path from "node:path";
import { DateTime } from "luxon";
import { buildAnnouncement, buildUpcomingSummary, releaseMentionRoleIds } from "./discordBot.js";
import { APP_NAME, APP_VERSION, STATUS_OPTIONS, WEEKDAYS } from "./constants.js";
import {
  getNextRelease,
  getFinishedDeletionDate,
  listUpcomingTodayTomorrow,
  formatReleaseDate,
  formatEpisodeRange,
  getReleaseDayLabel,
  formatEpisodeEntries,
  isSeriesComplete
} from "./schedule.js";
import { syncAllLiveChart, syncOneSeriesFromLiveChart } from "./livechartSync.js";
import { cleanString, escapeHtml, parseInteger, toFormBoolean } from "./utils.js";
import {
  LANGUAGE_OPTIONS,
  languageLabel,
  languageShortLabel,
  normalizeEnabledLanguageCodes,
  normalizeLanguageCode,
  normalizeLanguageTracks
} from "./languages.js";
import { normalizePreferredService, pickPreferredService, serviceStyle, splitServiceNames } from "./services.js";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function requireBasicAuth(req, res, next) {
  const password = process.env.WEB_PASSWORD;
  if (!password) return next();

  const expectedUser = process.env.WEB_USER || "admin";
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", `Basic realm="${APP_NAME}"`);
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const user = decoded.slice(0, separator);
  const givenPassword = decoded.slice(separator + 1);

  if (user !== expectedUser || givenPassword !== password) {
    res.setHeader("WWW-Authenticate", `Basic realm="${APP_NAME}"`);
    return res.status(401).send("Authentication required");
  }

  return next();
}

function messageFromQuery(query) {
  if (query.ok) return `<div class="notice success">${escapeHtml(query.ok)}</div>`;
  if (query.error) return `<div class="notice error">${escapeHtml(query.error)}</div>`;
  return "";
}

function renderPage(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <script>
    (() => {
      const saved = localStorage.getItem("series-theme") || "light";
      document.documentElement.dataset.theme = saved === "dark" ? "dark" : "light";
    })();
  </script>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <div class="brand-block">
      <a class="brand" href="/">${escapeHtml(APP_NAME)}</a>
      <span class="app-version">v${escapeHtml(APP_VERSION)}</span>
    </div>
    <nav class="nav-links">
      <a href="/">Dashboard</a>
      <a href="/finished">Finished</a>
      <a href="/series/new">New Series</a>
      <a href="/settings">Settings</a>
      <a href="/api/upcoming">API</a>
    </nav>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Toggle theme">
      <span class="theme-dot"></span>
      <span id="themeLabel">Dark</span>
    </button>
  </header>
  <main class="shell">${content}</main>
  <script>
    (() => {
      const button = document.getElementById("themeToggle");
      const label = document.getElementById("themeLabel");
      const apply = (theme) => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem("series-theme", theme);
        if (label) label.textContent = theme === "dark" ? "Light" : "Dark";
      };
      apply(document.documentElement.dataset.theme || "light");
      button?.addEventListener("click", () => {
        apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      });
    })();
  </script>
</body>
</html>`;
}

function formatSyncStatus(settings) {
  if (!settings.lastLiveChartSyncAt) return "Not synced yet";
  const date = DateTime.fromISO(settings.lastLiveChartSyncAt, { zone: settings.timeZone || "Europe/Berlin" });
  if (!date.isValid) return "Not synced yet";
  return date.setLocale("en").toFormat("dd LLL yyyy HH:mm");
}

function renderHero(data, discordEnabled) {
  const syncEnabled = data.settings.liveChartSyncEnabled ? "LiveChart auto-sync on" : "LiveChart auto-sync off";
  const discord = discordEnabled ? "Discord connected" : "Discord not connected";

  return `<section class="hero-panel">
    <div>
      <p class="eyebrow">Anime Release Control</p>
      <h1>Release Dashboard</h1>
    </div>
    <div class="hero-meta">
      <span>${escapeHtml(syncEnabled)}</span>
      <span>${escapeHtml(discord)}</span>
      <span>Last sync: ${escapeHtml(formatSyncStatus(data.settings))}</span>
      ${
        data.settings.lastLiveChartSyncSummary
          ? `<span>${escapeHtml(data.settings.lastLiveChartSyncSummary)}</span>`
          : ""
      }
    </div>
  </section>`;
}

function renderStats(data, upcoming) {
  const active = data.series.filter((series) => series.enabled).length;
  const missingTime = data.series.filter((series) => {
    const release = getNextRelease(series, data.settings);
    return release?.missingTime;
  }).length;

  return `<section class="stats">
    <div><small>Series</small><span>${data.series.length}</span></div>
    <div><small>Active</small><span>${active}</span></div>
    <div><small>Today/tomorrow</small><span>${upcoming.length}</span></div>
    <div><small>Missing time</small><span>${missingTime}</span></div>
  </section>`;
}

function selectedDiscordChannelIds(settings) {
  const raw = Array.isArray(settings.discordChannelIds) && settings.discordChannelIds.length
    ? settings.discordChannelIds
    : settings.discordChannelId
      ? [settings.discordChannelId]
      : [];
  return new Set(raw.map((id) => cleanString(id)).filter(Boolean));
}

function selectedDiscordRoleIds(settings, arrayKey, legacyKey) {
  const raw = Array.isArray(settings[arrayKey]) && settings[arrayKey].length
    ? settings[arrayKey]
    : settings[legacyKey]
      ? [settings[legacyKey]]
      : [];
  return new Set(raw.map((id) => cleanString(id)).filter(Boolean));
}

function renderDiscordChannelSettings(settings, channelGroups, discordEnabled) {
  const selected = selectedDiscordChannelIds(settings);
  const visibleIds = new Set();

  const groups = channelGroups.length
    ? channelGroups
        .map((guild) => {
          const rows = guild.channels
            .map((channel) => {
              visibleIds.add(channel.id);
              const checked = selected.has(channel.id);
              const canUse = channel.canView && channel.canSend;
              const disabled = !canUse && !checked;
              const prefix = channel.kind === "forum-post" ? "Post" : "Text";
              const label = channel.kind === "forum-post"
                ? `${channel.parentName || "Forum"} / ${channel.name}`
                : `#${channel.name}`;
              const state = canUse
                ? "ready"
                : channel.canView
                  ? "missing send"
                  : "missing access";
              return `<label class="channel-row ${canUse ? "" : "disabled"}">
                <input type="checkbox" name="discordChannelIds" value="${escapeHtml(channel.id)}" ${
                  checked ? "checked" : ""
                } ${disabled ? "disabled" : ""}>
                <span class="channel-name"><small>${escapeHtml(prefix)}</small>${escapeHtml(label)}</span>
                <span class="channel-state ${canUse ? "ok" : "bad"}">${escapeHtml(state)}</span>
              </label>`;
            })
            .join("");

          return `<div class="channel-group">
            <h3>${escapeHtml(guild.name)}</h3>
            <div class="channel-grid">${rows || '<p class="muted-text">No announcement channels found.</p>'}</div>
          </div>`;
        })
        .join("")
    : `<p class="muted-text">${
        discordEnabled
          ? "Discord is connected, but no channel cache is available yet. Refresh this page in a moment."
          : "Discord token is missing, so channels cannot be loaded."
      }</p>`;

  const missingSelected = [...selected].filter((id) => !visibleIds.has(id));
  const preserved = missingSelected
    .map(
      (id) => `<label class="channel-row disabled">
        <input type="checkbox" name="discordChannelIds" value="${escapeHtml(id)}" checked>
        <span class="channel-name">${escapeHtml(id)}</span>
        <span class="channel-state bad">not visible</span>
      </label>`
    )
    .join("");

  return `<div class="span-2 channel-picker">
    <div class="field-label">Discord announcement channels</div>
    <input type="hidden" name="discordChannelIds" value="">
    ${groups}
    ${preserved ? `<div class="channel-group"><h3>Configured IDs</h3><div class="channel-grid">${preserved}</div></div>` : ""}
  </div>`;
}

function renderRolePicker({ name, title, description, selected, roleGroups, discordEnabled }) {
  const visibleIds = new Set();
  const groups = roleGroups.length
    ? roleGroups
        .map((guild) => {
          const rows = guild.roles
            .map((role) => {
              visibleIds.add(role.id);
              const checked = selected.has(role.id);
              const state = role.canMention ? (role.mentionable ? "mentionable" : "bot permission") : "not mentionable";
              return `<label class="role-row ${role.canMention ? "" : "disabled"}">
                <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(role.id)}" ${checked ? "checked" : ""}>
                <span class="role-dot" style="--role-color:${escapeHtml(role.color)}"></span>
                <span class="role-name"><small>${escapeHtml(guild.name)}</small>@${escapeHtml(role.name)}</span>
                <span class="role-state ${role.canMention ? "ok" : "bad"}">${escapeHtml(state)}</span>
              </label>`;
            })
            .join("");

          return `<div class="role-group">
            <h4>${escapeHtml(guild.name)}</h4>
            <div class="role-grid">${rows || '<p class="muted-text">No usable roles found.</p>'}</div>
          </div>`;
        })
        .join("")
    : `<p class="muted-text">${
        discordEnabled
          ? "Discord is connected, but no role cache is available yet. Refresh this page in a moment."
          : "Discord token is missing, so roles cannot be loaded."
      }</p>`;

  const preserved = [...selected]
    .filter((id) => !visibleIds.has(id))
    .map(
      (id) => `<label class="role-row disabled">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(id)}" checked>
        <span class="role-dot"></span>
        <span class="role-name"><small>Configured</small>${escapeHtml(id)}</span>
        <span class="role-state bad">not visible</span>
      </label>`
    )
    .join("");

  return `<div class="role-picker">
    <div class="role-picker-title">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
    </div>
    <input type="hidden" name="${escapeHtml(name)}" value="">
    ${groups}
    ${preserved ? `<div class="role-group"><h4>Configured IDs</h4><div class="role-grid">${preserved}</div></div>` : ""}
  </div>`;
}

function renderDiscordRoleSettings(settings, roleGroups, discordEnabled) {
  const releaseSelected = selectedDiscordRoleIds(settings, "discordReleaseRoleIds", "discordReleaseRoleId");
  const languageSelected = selectedDiscordRoleIds(settings, "discordLanguageRoleIds", "discordLanguageRoleId");
  const missingSelected = selectedDiscordRoleIds(settings, "discordMissingTimeRoleIds", "discordMissingTimeRoleId");

  return `<div class="span-2 role-settings">
    <div>
      <div class="field-label">Discord role mentions</div>
      <p class="muted-text">Selected roles are pinged only in matching automatic release posts. Pick one role per server if the bot posts to multiple Discord servers.</p>
    </div>
    ${renderRolePicker({
      name: "discordReleaseRoleIds",
      title: "Timed main releases",
      description: "Normal episodes with a known release time.",
      selected: releaseSelected,
      roleGroups,
      discordEnabled
    })}
    ${renderRolePicker({
      name: "discordLanguageRoleIds",
      title: "Language releases",
      description: "Dub or language-version posts with their own known time.",
      selected: languageSelected,
      roleGroups,
      discordEnabled
    })}
    ${renderRolePicker({
      name: "discordMissingTimeRoleIds",
      title: "Time missing fallback",
      description: "Posts that use the configured missing-time fallback.",
      selected: missingSelected,
      roleGroups,
      discordEnabled
    })}
  </div>`;
}

function renderSettingsTab(key, label, detail) {
  return `<button type="button" class="settings-tab" data-settings-target="${escapeHtml(key)}">
    <span>${escapeHtml(label)}</span>
    <small>${escapeHtml(detail)}</small>
  </button>`;
}

function renderSettingsSection(key, eyebrow, title, description, content) {
  const active = key === "discord" ? " is-active" : "";
  return `<section class="settings-section${active}" id="settings-${escapeHtml(key)}" data-settings-section="${escapeHtml(key)}">
    <div class="section-title">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(description)}</p>
    </div>
    <div class="settings-section-body">${content}</div>
  </section>`;
}

function renderSettingsScript() {
  return `<script>
    (() => {
      const tabs = [...document.querySelectorAll("[data-settings-target]")];
      const sections = [...document.querySelectorAll("[data-settings-section]")];
      const savebar = document.querySelector("[data-settings-savebar]");
      const valid = new Set(sections.map((section) => section.dataset.settingsSection));
      const normalize = (value) => {
        const key = String(value || "").replace(/^#?settings-/, "").replace(/^#/, "");
        return valid.has(key) ? key : "discord";
      };
      const show = (target) => {
        const key = normalize(target);
        tabs.forEach((tab) => {
          const active = tab.dataset.settingsTarget === key;
          tab.classList.toggle("active", active);
          tab.setAttribute("aria-selected", active ? "true" : "false");
        });
        sections.forEach((section) => {
          section.classList.toggle("is-active", section.dataset.settingsSection === key);
        });
        if (savebar) savebar.hidden = key === "import";
        localStorage.setItem("anime-sheduler-settings-tab", key);
        history.replaceState(null, "", "#settings-" + key);
      };
      tabs.forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.settingsTarget)));
      show(location.hash || localStorage.getItem("anime-sheduler-settings-tab"));
    })();
  </script>`;
}

function renderSettings(settings, discordEnabled, channelGroups = [], roleGroups = []) {
  const enabledLanguages = new Set(normalizeEnabledLanguageCodes(settings.enabledLanguageCodes || ["de"]));
  const languageOptions = LANGUAGE_OPTIONS.map(
    (language) => `<label class="check language-option">
      <input type="checkbox" name="enabledLanguageCodes" value="${escapeHtml(language.code)}" ${
        enabledLanguages.has(language.code) ? "checked" : ""
      }>
      <span>${escapeHtml(language.label)}</span>
    </label>`
  ).join("");

  const scheduleFields = `<div class="grid-form settings-field-grid">
    <label>
        <span>Time zone</span>
        <input name="timeZone" value="${escapeHtml(settings.timeZone)}" placeholder="Europe/Berlin">
      </label>
      <label>
        <span>Reminder minutes</span>
        <input type="number" min="0" name="reminderMinutes" value="${escapeHtml(settings.reminderMinutes)}">
      </label>
      <label>
        <span>Lookahead days</span>
        <input type="number" min="1" name="lookaheadDays" value="${escapeHtml(settings.lookaheadDays)}">
      </label>
      <label>
        <span>Scheduler seconds</span>
        <input type="number" min="30" name="schedulerIntervalSeconds" value="${escapeHtml(settings.schedulerIntervalSeconds)}">
      </label>
      <label>
        <span>Discord list limit</span>
        <input type="number" min="1" name="summaryLimit" value="${escapeHtml(settings.summaryLimit)}">
      </label>
      <label>
        <span>Missing time post</span>
        <input name="missingTimePostTime" value="${escapeHtml(settings.missingTimePostTime || "18:00")}" placeholder="18:00">
      </label>
    </div>`;

  const liveChartFields = `<div class="grid-form settings-field-grid">
      <label class="check span-2 boxed-check">
        <input type="checkbox" name="liveChartSyncEnabled" ${toFormBoolean(settings.liveChartSyncEnabled)}>
        <span>Update from LiveChart once per day</span>
      </label>
      <label>
        <span>LiveChart sync hour</span>
        <input type="number" min="0" max="23" name="liveChartSyncHour" value="${escapeHtml(settings.liveChartSyncHour)}">
      </label>
      <label>
        <span>Last LiveChart sync</span>
        <input value="${escapeHtml(formatSyncStatus(settings))}" readonly>
      </label>
      <div class="form-actions span-2">
        <button type="submit" class="button secondary" form="liveChartSyncForm">Sync LiveChart now</button>
      </div>
    </div>`;

  const languageFields = `<div class="settings-language-panel">
        <span class="field-label">Auto-enabled languages</span>
        <div class="language-settings-grid">${languageOptions}</div>
      </div>`;

  return `<section class="settings-console">
    <aside class="settings-sidebar" aria-label="Settings sections">
      <div class="settings-sidebar-title">
        <strong>Settings</strong>
        <span>${discordEnabled ? "Discord connected" : "Discord offline"}</span>
      </div>
      ${renderSettingsTab("discord", "Discord", "Channels and forum posts")}
      ${renderSettingsTab("mentions", "Mentions", "Role pings per release type")}
      ${renderSettingsTab("schedule", "Scheduler", "Timing and summaries")}
      ${renderSettingsTab("livechart", "LiveChart", "Daily sync controls")}
      ${renderSettingsTab("languages", "Languages", "Auto-enabled dub tracks")}
      ${renderSettingsTab("import", "Import", "CSV season updates")}
    </aside>
    <div class="settings-content">
      <form class="settings-form" method="post" action="/settings">
        ${renderSettingsSection("discord", "Discord", "Announcement Targets", "Choose where automatic release posts and summaries should be sent.", renderDiscordChannelSettings(settings, channelGroups, discordEnabled))}
        ${renderSettingsSection("mentions", "Discord", "Role Mentions", "Pick role pings for main releases, language versions, and missing-time fallback posts.", renderDiscordRoleSettings(settings, roleGroups, discordEnabled))}
        ${renderSettingsSection("schedule", "Timing", "Scheduler", "Control release timing, reminder behavior, and Discord summary sizes.", scheduleFields)}
        ${renderSettingsSection("livechart", "Sync", "LiveChart", "Run the daily LiveChart refresh and inspect the latest sync status.", liveChartFields)}
        ${renderSettingsSection("languages", "Languages", "Language Versions", "Choose which LiveChart language versions should be enabled automatically when found.", languageFields)}
        <div class="settings-savebar" data-settings-savebar>
          <span>Changes apply after saving.</span>
          <button type="submit">Save settings</button>
        </div>
      </form>
      ${renderImportPanel()}
      <form id="liveChartSyncForm" class="hidden-form" method="post" action="/sync-livechart-all"></form>
    </div>
  </section>
  ${renderSettingsScript()}`;
}

function renderImportPanel() {
  return `<section class="settings-section" id="settings-import" data-settings-section="import">
    <div class="section-title">
      <p class="eyebrow">Season Tools</p>
      <h2>CSV Import</h2>
      <p>Paste the full CSV. Manually edited times stay untouched by default.</p>
    </div>
    <form method="post" action="/import" class="stack">
      <textarea name="csv" rows="10" placeholder="title,service,premiere,rldate,nextep,epcount,..."></textarea>
      <div class="inline-options">
        <label class="check"><input type="checkbox" name="updateExisting" checked> Update existing series</label>
        <label class="check"><input type="checkbox" name="overwriteSchedule"> Overwrite schedule and episodes from CSV</label>
      </div>
      <div class="form-actions">
        <button type="submit">Import CSV</button>
      </div>
    </form>
  </section>`;
}

function renderServiceBadges(value, preferredService = "") {
  const services = splitServiceNames(value);
  if (!services.length) return `<span class="service-empty">-</span>`;
  const postService = pickPreferredService(value, preferredService);

  return `<div class="service-stack">${services
    .map((service) => {
      const colors = serviceStyle(service);
      const selected = postService && service.toLowerCase() === postService.toLowerCase();
      const fallback = service.toLowerCase() === "youtube" && postService.toLowerCase() !== "youtube";
      return `<span class="service-badge ${selected ? "selected" : ""} ${
        fallback ? "fallback" : ""
      }" title="${selected ? "Used for Discord posts" : "Available service"}" style="--service-bg:${colors.bg};--service-border:${colors.border};--service-ink:${colors.ink};">${escapeHtml(service)}</span>`;
    })
    .join("")}</div>`;
}

function renderPreferredServiceOptions(series) {
  const services = splitServiceNames(series.service);
  const selected = normalizePreferredService(series.preferredService, series.service);
  const autoLabel = services.some((service) => service.toLowerCase() === "youtube") && services.length > 1
    ? "Auto (prefer non-YouTube)"
    : "Auto";
  const options = [`<option value="" ${selected ? "" : "selected"}>${escapeHtml(autoLabel)}</option>`];

  for (const service of services) {
    options.push(
      `<option value="${escapeHtml(service)}" ${
        selected.toLowerCase() === service.toLowerCase() ? "selected" : ""
      }>${escapeHtml(service)}</option>`
    );
  }

  return options.join("");
}

function releaseDateKey(release, settings) {
  const value = release?.dateTime || release?.date;
  if (!value) return "";
  const date = value.setZone(settings.timeZone || "Europe/Berlin");
  return date.isValid ? date.toISODate() : "";
}

function renderUpcomingTime(release, settings) {
  if (!release) return `<div class="date-stack muted-date"><span>-</span></div>`;

  const localeDate = release.dateTime || release.date;
  if (!localeDate) return `<div class="date-stack muted-date"><span>-</span></div>`;

  const date = localeDate.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");
  if (!date.isValid) return `<div class="date-stack muted-date"><span>-</span></div>`;

  return `<div class="date-stack ${release.missingTime ? "missing" : ""}">
    <span class="date-time">${escapeHtml(release.missingTime ? "time missing" : date.toFormat("HH:mm"))}</span>
  </div>`;
}

function renderUpcoming(upcoming, settings, discordEnabled) {
  const renderEpisodeStack = (series, release) =>
    `<div class="episode-stack">${formatEpisodeEntries(series, release)
      .map((entry) => `<span class="episode-line ${escapeHtml(entry.kind)}">${escapeHtml(entry.text)}</span>`)
      .join("")}</div>`;

  const zone = settings.timeZone || "Europe/Berlin";
  const now = DateTime.now().setZone(zone);
  const buckets = [
    { title: "Today", date: now, empty: "No releases today." },
    { title: "Tomorrow", date: now.plus({ days: 1 }), empty: "No releases tomorrow." }
  ];

  const groups = buckets
    .map((bucket) => {
      const key = bucket.date.toISODate();
      const items = upcoming.filter(({ release }) => releaseDateKey(release, settings) === key);
      const rows = items.length
        ? items
            .map(({ series, release }) => {
              return `<li>
                ${renderUpcomingTime(release, settings)}
                <span><span class="series-name">${escapeHtml(series.title)}</span>${renderEpisodeStack(series, release)}</span>
                ${renderServiceBadges(series.service, series.preferredService)}
              </li>`;
            })
            .join("")
        : `<li class="empty">${escapeHtml(bucket.empty)}</li>`;

      return `<section class="upcoming-day">
        <div class="upcoming-day-header">
          <h3>${escapeHtml(bucket.title)}</h3>
          <span>${escapeHtml(bucket.date.setLocale("en").toFormat("cccc, dd LLL yyyy"))}</span>
        </div>
        <ol class="upcoming-list">${rows}</ol>
      </section>`;
    })
    .join("");

  return `<section class="panel">
    <div class="section-title split">
      <div>
        <h2>Upcoming Episodes</h2>
        <p>Only releases scheduled for today and tomorrow are shown here.</p>
      </div>
      <form method="post" action="/post-upcoming">
        <button type="submit" ${discordEnabled ? "" : "disabled"}>Post to Discord</button>
      </form>
    </div>
    <div class="upcoming-days">${groups}</div>
  </section>`;
}

function renderSeriesTable(seriesList, settings, emptyText = "No series imported yet.") {
  const renderEpisodeStack = (series, release) =>
    `<div class="episode-stack compact">${formatEpisodeEntries(series, release)
      .map((entry) => `<span class="episode-line ${escapeHtml(entry.kind)}">${escapeHtml(entry.text)}</span>`)
      .join("")}</div>`;

  const rows = seriesList
    .map((series) => {
      const release = getNextRelease(series, settings);
      const enabled = series.enabled ? "Active" : "Off";
      const day = getReleaseDayLabel(series.releaseDay) || "-";
      const time = series.releaseTime || "-";
      const css = series.enabled ? "pill on" : "pill off";
      return `<tr>
        <td><a class="title-link" href="/series/${escapeHtml(series.id)}">${escapeHtml(series.title)}</a></td>
        <td>${renderServiceBadges(series.service, series.preferredService)}</td>
        <td>${escapeHtml(day)}<small>${escapeHtml(time)}</small></td>
        <td>${escapeHtml(series.nextDate || "-")}</td>
        <td>${renderEpisodeStack(series, release)}</td>
        <td>${escapeHtml(formatReleaseDate(release, settings, false))}</td>
        <td><span class="${css}">${enabled}</span></td>
        <td><a class="button secondary" href="/series/${escapeHtml(series.id)}">Edit</a></td>
      </tr>`;
    })
    .join("");

  return `<section class="panel wide">
    <div class="section-title split">
      <div>
        <h2>Series</h2>
        <p>Edit release day, time, manual delays, and episode numbers.</p>
      </div>
      <input class="search" id="seriesSearch" placeholder="Search...">
    </div>
    <div class="table-wrap">
      <table id="seriesTable">
        <thead>
          <tr>
            <th>Title</th>
            <th>Service</th>
            <th>Pattern</th>
            <th>Next date</th>
            <th>Episode</th>
            <th>Next post</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="8">${escapeHtml(emptyText)}</td></tr>`}</tbody>
      </table>
    </div>
    <script>
      const input = document.getElementById('seriesSearch');
      const rows = [...document.querySelectorAll('#seriesTable tbody tr')];
      input?.addEventListener('input', () => {
        const term = input.value.toLowerCase();
        rows.forEach((row) => {
          row.style.display = row.textContent.toLowerCase().includes(term) ? '' : 'none';
        });
      });
    </script>
  </section>`;
}

function renderDashboard(data, discordEnabled, query) {
  const upcoming = listUpcomingTodayTomorrow(data.series, data.settings);
  const dashboardSeries = data.series.filter((series) => !isSeriesComplete(series));
  return renderPage(
    APP_NAME,
    `${messageFromQuery(query)}
    ${renderHero(data, discordEnabled)}
    ${renderStats(data, upcoming)}
    <div class="main-column">
      ${renderUpcoming(upcoming, data.settings, discordEnabled)}
      ${renderSeriesTable(dashboardSeries, data.settings, "No active or pending series. Finished entries are in the Finished tab.")}
    </div>`
  );
}

function formatLifecycleDate(value, settings, fallback = "Not set") {
  const text = cleanString(value);
  if (!text) return fallback;

  const date = DateTime.fromISO(text, { zone: settings.timeZone || "Europe/Berlin" });
  if (!date.isValid) return fallback;
  return date.setLocale("en").toFormat("dd LLL yyyy HH:mm");
}

function renderFinishedPage(data, query) {
  const now = DateTime.now().setZone(data.settings.timeZone || "Europe/Berlin");
  const finished = data.series
    .filter((series) => isSeriesComplete(series))
    .sort((a, b) => cleanString(b.finishedAt || b.updatedAt).localeCompare(cleanString(a.finishedAt || a.updatedAt)));

  const rows = finished
    .map((series) => {
      const deletionDate = getFinishedDeletionDate(series, data.settings);
      const isDue = deletionDate && now >= deletionDate;
      const cleanup = deletionDate
        ? deletionDate.setLocale("en").toFormat("dd LLL yyyy HH:mm")
        : "Waiting for total episodes";
      const totalUpdated = Number.isFinite(series.episodeCount)
        ? formatLifecycleDate(series.episodeCountUpdatedAt, data.settings)
        : "No total count";
      return `<tr>
        <td><a class="title-link" href="/series/${escapeHtml(series.id)}">${escapeHtml(series.title)}</a></td>
        <td>${renderServiceBadges(series.service, series.preferredService)}</td>
        <td>${Number.isFinite(series.episodeCount) ? escapeHtml(series.episodeCount) : "-"}</td>
        <td>${escapeHtml(formatLifecycleDate(series.finishedAt, data.settings))}</td>
        <td>${escapeHtml(totalUpdated)}</td>
        <td>
          <span class="pill ${isDue ? "warn" : "off"}">${escapeHtml(isDue ? "Due on next sync" : cleanup)}</span>
        </td>
        <td><a class="button secondary" href="/series/${escapeHtml(series.id)}">Edit</a></td>
      </tr>`;
    })
    .join("");

  return renderPage(
    "Finished Series",
    `${messageFromQuery(query)}
    <section class="hero-panel">
      <div>
        <p class="eyebrow">Archive</p>
        <h1>Finished Series</h1>
      </div>
      <div class="hero-meta">
        <span>${finished.length} finished</span>
        <span>Auto-delete after 1 month of stable totals</span>
      </div>
    </section>
    <section class="panel wide">
      <div class="section-title split">
        <div>
          <h2>Finished Entries</h2>
          <p>Entries stay checked during LiveChart sync and are removed after the total episode count has been stable for one month. Specials without a total count use the finished date.</p>
        </div>
        <form method="post" action="/sync-livechart-all">
          <input type="hidden" name="returnTo" value="/finished">
          <button type="submit" class="button secondary">Sync LiveChart now</button>
        </form>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Service</th>
              <th>Total</th>
              <th>Finished</th>
              <th>Total updated</th>
              <th>Cleanup</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="7">No finished series yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>`
  );
}

function renderSettingsPage(data, discordEnabled, query, channelGroups = [], roleGroups = []) {
  return renderPage(
    "Settings",
    `${messageFromQuery(query)}
    <section class="hero-panel">
      <div>
        <p class="eyebrow">Configuration</p>
        <h1>Settings</h1>
      </div>
      <div class="hero-meta">
        <span>Last sync: ${escapeHtml(formatSyncStatus(data.settings))}</span>
      </div>
    </section>
    <div class="settings-layout">
      ${renderSettings(data.settings, discordEnabled, channelGroups, roleGroups)}
    </div>`
  );
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderDayOptions(selected) {
  return `<option value="">Not set</option>${WEEKDAYS.map((day) => option(day.key, day.label, selected)).join("")}`;
}

function renderStatusOptions(selected) {
  return STATUS_OPTIONS.map(([value, label]) => option(value, label, selected)).join("");
}

function languageFieldKey(code) {
  return normalizeLanguageCode(code).replace(/[^a-z0-9]+/g, "_");
}

function renderLanguageTrackSettings(series) {
  const tracks = normalizeLanguageTracks(series.languageTracks || []);
  const trackByCode = new Map(tracks.map((track) => [track.code, track]));
  const codes = new Set([...LANGUAGE_OPTIONS.map((language) => language.code), ...tracks.map((track) => track.code)]);

  const rows = [...codes]
    .map((code) => {
      const normalized = normalizeLanguageCode(code);
      const key = languageFieldKey(normalized);
      const track = trackByCode.get(normalized) || {
        code: normalized,
        label: languageLabel(normalized),
        enabled: false,
        available: false,
        nextEpisode: null
      };
      const availability = track.available ? "available" : "manual";
      return `<div class="language-track-row">
        <input type="hidden" name="languageCodes" value="${escapeHtml(normalized)}">
        <input type="hidden" name="languageAvailable_${escapeHtml(key)}" value="${track.available ? "1" : "0"}">
        <label class="check">
          <input type="checkbox" name="languageEnabled_${escapeHtml(key)}" ${toFormBoolean(track.enabled)}>
          <span>${escapeHtml(track.label)}</span>
        </label>
        <span class="language-short">${escapeHtml(languageShortLabel(normalized))}</span>
        <input type="number" min="0" name="languageEpisode_${escapeHtml(key)}" value="${
          Number.isFinite(track.nextEpisode) ? escapeHtml(track.nextEpisode) : ""
        }" placeholder="Episode">
        <input type="number" min="1" name="languageBatchSize_${escapeHtml(key)}" value="${escapeHtml(track.episodeBatchSize || 1)}" placeholder="Count">
        <select name="languageReleaseDay_${escapeHtml(key)}">${renderDayOptions(track.releaseDay || "")}</select>
        <input type="time" name="languageReleaseTime_${escapeHtml(key)}" value="${escapeHtml(track.releaseTime || "")}">
        <input type="date" name="languageNextDate_${escapeHtml(key)}" value="${escapeHtml(track.nextDate || "")}">
        <span class="track-state">${escapeHtml(availability)}</span>
      </div>`;
    })
    .join("");

  return `<div class="span-2 language-tracks">
    <div class="section-title compact">
      <h2>Language Versions</h2>
      <p>Enable language versions that should appear in Discord posts with their own episode number.</p>
    </div>
    <div class="language-track-grid">${rows}</div>
  </div>`;
}

function renderSeriesLifecyclePanel(series, settings) {
  if (!isSeriesComplete(series)) return "";

  const deletionDate = getFinishedDeletionDate(series, settings);
  const basis = Number.isFinite(series.episodeCount)
    ? `Total episode count last changed: ${formatLifecycleDate(series.episodeCountUpdatedAt, settings)}`
    : `No total episode count on LiveChart. Timer uses finished date: ${formatLifecycleDate(series.finishedAt, settings)}`;
  const cleanup = deletionDate
    ? deletionDate.setLocale("en").toFormat("dd LLL yyyy HH:mm")
    : "Waiting for lifecycle data";

  return `<section class="panel lifecycle-panel">
    <div class="section-title split">
      <div>
        <h2>Finished Lifecycle</h2>
        <p>${escapeHtml(basis)}</p>
      </div>
      <span class="pill off">Auto-delete: ${escapeHtml(cleanup)}</span>
    </div>
  </section>`;
}

function renderSeriesForm(series, settings, query, isNew = false, discordEnabled = true) {
  const release = getNextRelease(series, settings);
  const action = isNew ? "/series" : `/series/${encodeURIComponent(series.id)}`;
  const title = isNew ? "New Series" : series.title;

  return renderPage(
    title,
    `${messageFromQuery(query)}
    <section class="panel wide">
      <div class="section-title split">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>Next release: ${escapeHtml(formatReleaseDate(release, settings))}</p>
        </div>
        <a class="button secondary" href="/">Back</a>
      </div>
      <form class="grid-form edit-form" method="post" action="${action}">
        <label class="span-2">
          <span>Title</span>
          <input name="title" required value="${escapeHtml(series.title)}">
        </label>
        <label>
          <span>Service</span>
          <input name="service" value="${escapeHtml(series.service)}" placeholder="Crunchyroll">
        </label>
        <label>
          <span>Post service</span>
          <select name="preferredService">${renderPreferredServiceOptions(series)}</select>
        </label>
        <label>
          <span>Status</span>
          <select name="status">${renderStatusOptions(series.status)}</select>
        </label>
        <label>
          <span>Premiere</span>
          <input type="date" name="premiereDate" value="${escapeHtml(series.premiereDate)}">
        </label>
        <label>
          <span>Release day</span>
          <select name="releaseDay">${renderDayOptions(series.releaseDay)}</select>
        </label>
        <label>
          <span>Time</span>
          <input type="time" name="releaseTime" value="${escapeHtml(series.releaseTime)}">
        </label>
        <label>
          <span>Next date</span>
          <input type="date" name="nextDate" value="${escapeHtml(series.nextDate)}">
        </label>
        <label>
          <span>Next episode</span>
          <input type="number" min="0" name="nextEpisode" value="${Number.isFinite(series.nextEpisode) ? escapeHtml(series.nextEpisode) : ""}">
        </label>
        <label>
          <span>Episodes this release</span>
          <input type="number" min="1" name="episodeBatchSize" value="${escapeHtml(series.episodeBatchSize || 1)}">
        </label>
        <label>
          <span>Total episodes</span>
          <input type="number" min="0" name="episodeCount" value="${Number.isFinite(series.episodeCount) ? escapeHtml(series.episodeCount) : ""}">
        </label>
        <label class="span-2">
          <span>Schedule-Link</span>
          <input name="scheduleLink" value="${escapeHtml(series.scheduleLink)}">
        </label>
        <label class="span-2">
          <span>Image URL</span>
          <input name="imageUrl" value="${escapeHtml(series.imageUrl)}" placeholder="https://example.com/poster.jpg">
        </label>
        <label class="span-2">
          <span>Note</span>
          <textarea name="note" rows="4">${escapeHtml(series.note)}</textarea>
        </label>
        <div class="inline-options span-2">
          <label class="check"><input type="checkbox" name="enabled" ${toFormBoolean(series.enabled)}> Active</label>
          <label class="check"><input type="checkbox" name="weekly" ${toFormBoolean(series.weekly)}> Continue weekly</label>
        </div>
        ${renderLanguageTrackSettings(series)}
        <div class="form-actions span-2">
          <button type="submit">Save</button>
          ${
            isNew
              ? ""
              : '<button type="submit" formaction="' + action + '/sync-livechart">LiveChart sync</button>'
          }
          ${
            isNew
              ? ""
              : '<button type="submit" formaction="' +
                action +
                '/test-post" ' +
                (discordEnabled ? "" : "disabled") +
                ">Send test post</button>"
          }
        </div>
      </form>
    </section>
    ${isNew ? "" : renderSeriesLifecyclePanel(series, settings)}
    ${
      isNew
        ? ""
        : `<section class="panel danger">
            <h2>Delete</h2>
            <p>Removes this series from the bot data store.</p>
            <form method="post" action="${action}/delete" onsubmit="return confirm('Delete this series?')">
              <button type="submit">Delete series</button>
            </form>
          </section>`
    }`
  );
}

function formToSeries(body, id = "") {
  const rawCodes = Array.isArray(body.languageCodes) ? body.languageCodes : body.languageCodes ? [body.languageCodes] : [];
  const languageTracks = rawCodes
    .map((code) => {
      const normalized = normalizeLanguageCode(code);
      const key = languageFieldKey(normalized);
      return {
        code: normalized,
        label: languageLabel(normalized),
        enabled: body[`languageEnabled_${key}`] === "on",
        available: body[`languageAvailable_${key}`] === "1",
        nextEpisode: parseInteger(body[`languageEpisode_${key}`]),
        episodeBatchSize: parseInteger(body[`languageBatchSize_${key}`]),
        releaseDay: cleanString(body[`languageReleaseDay_${key}`]),
        releaseTime: cleanString(body[`languageReleaseTime_${key}`]),
        nextDate: cleanString(body[`languageNextDate_${key}`])
      };
    })
    .filter((track) => track.code);
  const germanTrack = languageTracks.find((track) => track.code === "de");

  return {
    id,
    title: cleanString(body.title),
    service: cleanString(body.service),
    preferredService: cleanString(body.preferredService),
    premiereDate: cleanString(body.premiereDate),
    releaseDay: cleanString(body.releaseDay),
    releaseTime: cleanString(body.releaseTime),
    nextDate: cleanString(body.nextDate),
    nextEpisode: parseInteger(body.nextEpisode),
    episodeBatchSize: parseInteger(body.episodeBatchSize),
    languageTracks,
    dubNextEpisode: germanTrack?.nextEpisode ?? null,
    episodeCount: parseInteger(body.episodeCount),
    scheduleLink: cleanString(body.scheduleLink),
    imageUrl: cleanString(body.imageUrl),
    note: cleanString(body.note),
    status: cleanString(body.status) || "unknown",
    enabled: body.enabled === "on",
    weekly: body.weekly === "on",
    dubbed: Boolean(germanTrack?.enabled)
  };
}

export function createWebApp(store, discord, rootDir = process.cwd()) {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "5mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(rootDir, "public")));
  app.use(requireBasicAuth);

  app.get(
    "/",
    asyncRoute(async (req, res) => {
      res.send(renderDashboard(store.snapshot(), discord.enabled, req.query));
    })
  );

  app.get(
    "/finished",
    asyncRoute(async (req, res) => {
      res.send(renderFinishedPage(store.snapshot(), req.query));
    })
  );

  app.get(
    "/settings",
    asyncRoute(async (req, res) => {
      const [channelGroups, roleGroups] = await Promise.all([
        discord.listTextChannels().catch((error) => {
          console.warn(`Could not load Discord channels: ${error.message}`);
          return [];
        }),
        discord.listMentionRoles().catch((error) => {
          console.warn(`Could not load Discord roles: ${error.message}`);
          return [];
        })
      ]);
      res.send(renderSettingsPage(store.snapshot(), discord.enabled, req.query, channelGroups, roleGroups));
    })
  );

  app.post(
    "/settings",
    asyncRoute(async (req, res) => {
      await store.updateSettings(req.body);
      res.redirect("/settings?ok=Settings saved");
    })
  );

  app.post(
    "/import",
    asyncRoute(async (req, res) => {
      const csv = cleanString(req.body.csv);
      if (!csv) return res.redirect("/settings?error=CSV is missing");
      const result = await store.importCsv(csv, {
        updateExisting: req.body.updateExisting === "on",
        overwriteSchedule: req.body.overwriteSchedule === "on"
      });
      res.redirect(
        `/settings?ok=${encodeURIComponent(
          `Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`
        )}`
      );
    })
  );

  app.post(
    "/post-upcoming",
    asyncRoute(async (req, res) => {
      const data = store.snapshot();
      const upcoming = listUpcomingTodayTomorrow(data.series, data.settings);
      const message = buildUpcomingSummary(upcoming, data.settings, data.settings.summaryLimit);
      try {
        await discord.post(message);
        await store.addPostLog({
          type: "manual-summary",
          message: typeof message === "string" ? message : `Upcoming Episodes summary (${upcoming.length} item(s))`
        });
        res.redirect("/?ok=Summary posted");
      } catch (error) {
        res.redirect(`/?error=${encodeURIComponent(error.message)}`);
      }
    })
  );

  app.post(
    "/sync-livechart-all",
    asyncRoute(async (req, res) => {
      const returnTo = cleanString(req.body.returnTo) === "/finished" ? "/finished" : "/settings";
      try {
        const result = await syncAllLiveChart(store);
        res.redirect(`${returnTo}?ok=${encodeURIComponent(`LiveChart sync: ${result.summary}`)}`);
      } catch (error) {
        res.redirect(`${returnTo}?error=${encodeURIComponent(error.message)}`);
      }
    })
  );

  app.get(
    "/series/new",
    asyncRoute(async (req, res) => {
      res.send(
        renderSeriesForm(
          {
            title: "",
            service: "",
            preferredService: "",
            premiereDate: "",
            releaseDay: "",
            releaseTime: "",
            nextDate: "",
            nextEpisode: null,
            episodeBatchSize: 1,
            episodeCount: null,
            languageTracks: [],
            scheduleLink: "",
            imageUrl: "",
            note: "",
            status: "planned",
            enabled: true,
            weekly: true,
            dubbed: false
          },
          store.getSettings(),
          req.query,
          true,
          discord.enabled
        )
      );
    })
  );

  app.post(
    "/series",
    asyncRoute(async (req, res) => {
      const series = await store.upsertSeries(formToSeries(req.body));
      res.redirect(`/series/${encodeURIComponent(series.id)}?ok=Series created`);
    })
  );

  app.get(
    "/series/:id",
    asyncRoute(async (req, res) => {
      const series = store.getSeries(req.params.id);
      if (!series) return res.status(404).send(renderPage("Not Found", "<p>Series not found.</p>"));
      res.send(renderSeriesForm(series, store.getSettings(), req.query, false, discord.enabled));
    })
  );

  app.post(
    "/series/:id",
    asyncRoute(async (req, res) => {
      const existing = store.getSeries(req.params.id);
      if (!existing) return res.redirect("/?error=Series not found");
      await store.upsertSeries({ ...existing, ...formToSeries(req.body, existing.id) });
      res.redirect(`/series/${encodeURIComponent(existing.id)}?ok=Series saved`);
    })
  );

  app.post(
    "/series/:id/test-post",
    asyncRoute(async (req, res) => {
      const existing = store.getSeries(req.params.id);
      if (!existing) return res.redirect("/?error=Series not found");
      const patch = await store.upsertSeries({ ...existing, ...formToSeries(req.body, existing.id) });
      const release = getNextRelease(patch, store.getSettings(), DateTime.now());
      if (!release) return res.redirect(`/series/${encodeURIComponent(existing.id)}?error=No release date could be calculated`);
      const message = buildAnnouncement(patch, release, store.getSettings());
      try {
        await discord.post(message, undefined, { mentionRoleIds: releaseMentionRoleIds(release, store.getSettings()) });
        await store.addPostLog({ type: "manual-test", seriesId: patch.id, title: patch.title, message });
        res.redirect(`/series/${encodeURIComponent(existing.id)}?ok=Test post sent`);
      } catch (error) {
        res.redirect(`/series/${encodeURIComponent(existing.id)}?error=${encodeURIComponent(error.message)}`);
      }
    })
  );

  app.post(
    "/series/:id/sync-livechart",
    asyncRoute(async (req, res) => {
      const existing = store.getSeries(req.params.id);
      if (!existing) return res.redirect("/?error=Series not found");

      const patch = { ...existing, ...formToSeries(req.body, existing.id) };
      try {
        const saved = await store.upsertSeries(patch);
        const synced = await syncOneSeriesFromLiveChart(store, saved);
        const updated = synced.updated || store.getSeries(saved.id) || saved;
        const live = synced.live;
        const parts = [];
        if (Number.isFinite(live.nextEpisode)) {
          parts.push(formatEpisodeRange({ episode: live.nextEpisode, episodeBatchSize: live.episodeBatchSize, episodeEnd: live.nextEpisode + (live.episodeBatchSize || 1) - 1 }));
        }
        for (const track of live.languageTracks || []) {
          if (Number.isFinite(track.nextEpisode)) {
            const range = formatEpisodeRange({
              episode: track.nextEpisode,
              episodeBatchSize: track.episodeBatchSize,
              episodeEnd: track.nextEpisode + (track.episodeBatchSize || 1) - 1
            });
            parts.push(`${track.label} ${range}`);
          }
        }
        res.redirect(
          `/series/${encodeURIComponent(updated.id)}?ok=${encodeURIComponent(
            `LiveChart updated: ${parts.join(" / ") || "no episodes found"}`
          )}`
        );
      } catch (error) {
        res.redirect(`/series/${encodeURIComponent(existing.id)}?error=${encodeURIComponent(error.message)}`);
      }
    })
  );

  app.post(
    "/series/:id/delete",
    asyncRoute(async (req, res) => {
      await store.deleteSeries(req.params.id);
      res.redirect("/?ok=Series deleted");
    })
  );

  app.get(
    "/api/upcoming",
    asyncRoute(async (req, res) => {
      const data = store.snapshot();
      const upcoming = listUpcomingTodayTomorrow(data.series, data.settings).map(({ series, release }) => ({
        id: series.id,
        title: series.title,
        service: series.service,
        preferredService: series.preferredService || "",
        postService: pickPreferredService(series.service, series.preferredService),
        imageUrl: series.imageUrl,
        nextEpisode: release.episode,
        episodeEnd: release.episodeEnd,
        episodeBatchSize: release.episodeBatchSize,
        languageTracks: normalizeLanguageTracks(series.languageTracks || []).filter((track) => track.enabled),
        dubNextEpisode: series.dubbed && Number.isFinite(series.dubNextEpisode) ? series.dubNextEpisode : null,
        releaseAt: release.dateTime?.toISO() || null,
        date: release.date?.toISODate() || null,
        missingTime: release.missingTime
      }));
      res.json({ settings: data.settings, upcoming });
    })
  );

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).send(renderPage("Error", `<pre>${escapeHtml(error.stack || error.message)}</pre>`));
  });

  return app;
}
