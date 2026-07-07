import {
  Client,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { DateTime } from "luxon";
import {
  getReleaseDayLabel,
  listReleasesForWeekday,
  listUpcomingTodayTomorrow,
  formatEpisodeEntries,
  getMissingTimePostTime,
  normalizeReleaseDay
} from "./schedule.js";
import { WEEKDAYS } from "./constants.js";
import { cleanString, normalizeHttpUrl } from "./utils.js";
import { pickPreferredService } from "./services.js";

function normalizeChannelIds(value) {
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

function normalizeRoleIds(value) {
  return normalizeChannelIds(value);
}

function getChannelIds(store) {
  const settings = store.getSettings();
  const configured = normalizeChannelIds(settings.discordChannelIds);
  if (configured.length) return configured;
  return normalizeChannelIds(settings.discordChannelId || process.env.DISCORD_CHANNEL_ID);
}

function truncate(value, maxLength) {
  const text = cleanString(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeMarkdown(value) {
  return cleanString(value).replace(/([\\*_`~|>])/g, "\\$1");
}

function messagePayload(content) {
  if (typeof content === "string") {
    return {
      content: content.slice(0, 1900),
      allowedMentions: { parse: [] }
    };
  }

  return {
    ...content,
    allowedMentions: content.allowedMentions || { parse: [] }
  };
}

function mentionUserPayload(content, userId) {
  const payload = messagePayload(content);
  const mention = `<@${userId}>`;

  return {
    ...payload,
    content: payload.content ? `${mention}\n${payload.content}`.slice(0, 2000) : mention,
    allowedMentions: { users: [userId] }
  };
}

function roleIdsFromSettings(settings, arrayKey, legacyKey) {
  const fromArray = normalizeRoleIds(settings?.[arrayKey]);
  if (fromArray.length) return fromArray;
  return normalizeRoleIds(settings?.[legacyKey]);
}

export function releaseMentionRoleIds(release, settings = {}) {
  if (Array.isArray(release?.releases) && release.releases.length) {
    return [...new Set(release.releases.flatMap((item) => releaseMentionRoleIds(item, settings)))];
  }

  if (!release) return [];
  if (release.missingTime) {
    return roleIdsFromSettings(settings, "discordMissingTimeRoleIds", "discordMissingTimeRoleId");
  }
  if (release.kind === "language") {
    return roleIdsFromSettings(settings, "discordLanguageRoleIds", "discordLanguageRoleId");
  }
  return roleIdsFromSettings(settings, "discordReleaseRoleIds", "discordReleaseRoleId");
}

function withRoleMentions(content, roleIds) {
  const ids = normalizeRoleIds(roleIds);
  const payload = messagePayload(content);
  if (!ids.length) return payload;

  const mentionLine = ids.map((id) => `<@&${id}>`).join(" ");
  const allowedMentions = {
    ...(payload.allowedMentions || {}),
    parse: [],
    roles: [...new Set([...(payload.allowedMentions?.roles || []), ...ids])]
  };

  return {
    ...payload,
    content: payload.content ? `${mentionLine}\n${payload.content}`.slice(0, 2000) : mentionLine,
    allowedMentions
  };
}

async function mentionRoleIdsForChannel(channel, roleIds) {
  const ids = normalizeRoleIds(roleIds);
  if (!ids.length || !channel.guild) return [];

  const fetched = await channel.guild.roles.fetch().catch(() => null);
  const roles = fetched || channel.guild.roles.cache;
  return ids.filter((id) => roles.has(id));
}

function releaseTitle(series, release) {
  const entries = formatEpisodeEntries(series, release);
  const entry = entries.find((item) => item.kind === "main") || entries.find((item) => item.kind === "language");
  return entry ? `${series.title} - ${entry.text}` : series.title;
}

function releaseDateParts(release, settings) {
  if (!release) return { date: "No release date", time: "-" };
  const value = release.dateTime || release.date;
  if (!value) return { date: "No release date", time: "-" };

  const date = value.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");
  if (!date.isValid) return { date: "No release date", time: "-" };

  return {
    date: date.toFormat("ccc, dd LLL yyyy"),
    time: release.missingTime ? "time missing" : date.toFormat("HH:mm")
  };
}

const BLANK_INLINE_FIELD = { name: "\u200B", value: "\u200B", inline: true };
const EMBED_WIDTH_SPACER = "\u2800".repeat(46);

function stableWidthField() {
  return { name: "\u200B", value: EMBED_WIDTH_SPACER, inline: false };
}

function releaseVersionLabel(release) {
  if (Array.isArray(release?.releases) && release.releases.length) {
    const labels = release.releases.map((item) =>
      item.kind === "language" ? item.languageLabel || item.languageCode || "Language" : "Original"
    );
    return [...new Set(labels)].join(" + ");
  }

  if (release?.kind === "language") return release.languageLabel || release.languageCode || "Language";
  return "Original";
}

export function buildAnnouncement(series, release, settings) {
  const isCombinedRelease = Array.isArray(release?.releases) && release.releases.length > 1;
  const entries = formatEpisodeEntries(series, release);
  const mainEpisode = entries.find((entry) => entry.kind === "main");
  const versionEpisodes = entries.filter((entry) => entry.kind === "language");
  const episodeText = isCombinedRelease && !mainEpisode
    ? versionEpisodes.map((entry) => entry.text).join("\n") || "Next episode"
    : (mainEpisode || entries.find((entry) => entry.kind === "language"))?.text || "Next episode";
  const languageEpisodes =
    release?.kind === "language" || (isCombinedRelease && !mainEpisode) ? [] : versionEpisodes.map((entry) => entry.text);
  const releaseDate = releaseDateParts(release, settings);
  const scheduleUrl = normalizeHttpUrl(series.scheduleLink);
  const imageUrl = normalizeHttpUrl(series.imageUrl);
  const postService = pickPreferredService(series.service, series.preferredService);
  const description = truncate(
    series.note ||
      (release?.missingTime
        ? "The exact release time is unknown, so this announcement uses the configured fallback time."
        : release?.kind === "language"
          ? `A new ${release.languageLabel || "language"} episode is available now.`
          : isCombinedRelease
            ? "New versions are available now."
            : "A new episode is available now."),
    240
  );

  const embed = new EmbedBuilder()
    .setColor(0x8bb4ff)
    .setTitle(truncate(releaseTitle(series, release), 256))
    .setDescription(description)
    .addFields(
      { name: "Date", value: truncate(releaseDate.date, 1024), inline: true },
      { name: "Time", value: truncate(releaseDate.time, 1024), inline: true },
      { name: "Episode", value: truncate(episodeText, 1024), inline: true },
      { name: "Service", value: truncate(postService || "-", 1024), inline: true },
      { name: "Version", value: truncate(releaseVersionLabel(release), 1024), inline: true },
      { name: "Source", value: scheduleUrl ? `[Open schedule](${scheduleUrl})` : "-", inline: true }
    )
    .setTimestamp(new Date());

  if (languageEpisodes.length) {
    embed.addFields({ name: "Language versions", value: truncate(languageEpisodes.join("\n"), 1024), inline: false });
  }

  if (release?.missingTime) {
    embed.addFields(
      {
        name: "Auto-post time",
        value: `${getMissingTimePostTime(settings)} (time missing fallback)`,
        inline: true
      },
      BLANK_INLINE_FIELD,
      BLANK_INLINE_FIELD
    );
  }

  if (scheduleUrl) {
    embed.setURL(scheduleUrl);
  }

  embed.addFields(stableWidthField());

  if (imageUrl) {
    embed.setThumbnail(imageUrl);
  }

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

function summaryDateLabel(release, settings, base = DateTime.now()) {
  const value = release?.dateTime || release?.date;
  if (!value) return "No release date";

  const date = value.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");
  if (!date.isValid) return "No release date";

  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const key = date.toISODate();
  const prefix = key === now.toISODate() ? "Today" : key === now.plus({ days: 1 }).toISODate() ? "Tomorrow" : date.toFormat("cccc");
  return `${prefix} - ${date.toFormat("cccc, dd LLL yyyy")}`;
}

function calendarDateLabel(release, settings) {
  const value = release?.dateTime || release?.date;
  if (!value) return "No release date";

  const date = value.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");
  if (!date.isValid) return "No release date";
  return date.toFormat("cccc, dd LLL yyyy");
}

function summaryTimeLabel(release, settings) {
  if (release?.missingTime) return "time missing";
  const value = release?.dateTime || release?.date;
  if (!value) return "-";

  const date = value.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");
  if (!date.isValid) return "-";
  return release?.dateTime ? date.toFormat("HH:mm") : "time missing";
}

function summaryEpisodeLabel(series, release) {
  return formatEpisodeEntries(series, release)
    .map((entry) => entry.text)
    .join(" / ");
}

function summaryLine(series, release, settings) {
  const title = escapeMarkdown(truncate(series.title, 86));
  const time = escapeMarkdown(summaryTimeLabel(release, settings));
  const episode = escapeMarkdown(summaryEpisodeLabel(series, release) || "Next episode");
  const service = pickPreferredService(series.service, series.preferredService);
  const serviceText = service ? ` - ${escapeMarkdown(service)}` : "";

  return `- \`${time}\` **${title}**\n  ${episode}${serviceText}`;
}

function groupedSummaryFields(items, settings, base = DateTime.now(), labeler = summaryDateLabel) {
  const groups = new Map();
  for (const { series, release } of items) {
    const label = labeler(release, settings, base);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(summaryLine(series, release, settings));
  }

  const fields = [];
  for (const [label, lines] of groups.entries()) {
    let chunk = "";
    let index = 0;
    for (const line of lines) {
      const next = chunk ? `${chunk}\n${line}` : line;
      if (next.length > 1024 && chunk) {
        fields.push({ name: index ? `${label} continued` : label, value: chunk, inline: false });
        index += 1;
        chunk = line;
      } else {
        chunk = next;
      }
    }
    if (chunk) fields.push({ name: index ? `${label} continued` : label, value: chunk, inline: false });
  }

  return fields.slice(0, 25);
}

export function buildUpcomingSummary(items, settings, limit = 12) {
  const visible = items.slice(0, limit);
  if (!visible.length) return "No releases today or tomorrow.";

  const hiddenCount = Math.max(0, items.length - visible.length);
  const description = hiddenCount
    ? `Showing ${visible.length} of ${items.length} releases for today and tomorrow.`
    : `Showing ${visible.length} releases for today and tomorrow.`;
  const embed = new EmbedBuilder()
    .setColor(0x8bb4ff)
    .setTitle("Upcoming Episodes")
    .setDescription(description)
    .addFields(groupedSummaryFields(visible, settings))
    .setTimestamp(new Date());

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export function buildWeekdayScheduleSummary(items, settings, weekdayKey, limit = 50) {
  const dayKey = normalizeReleaseDay(weekdayKey);
  const dayLabel = getReleaseDayLabel(dayKey) || "Selected day";
  const visible = items.slice(0, limit);
  if (!visible.length) return `No releases found for ${dayLabel}.`;

  const hiddenCount = Math.max(0, items.length - visible.length);
  const description = hiddenCount
    ? `Showing ${visible.length} of ${items.length} releases scheduled for ${dayLabel}.`
    : `Showing ${visible.length} releases scheduled for ${dayLabel}.`;
  const embed = new EmbedBuilder()
    .setColor(0x8bb4ff)
    .setTitle(`${dayLabel} Releases`)
    .setDescription(description)
    .addFields(groupedSummaryFields(visible, settings, DateTime.now(), calendarDateLabel))
    .setTimestamp(new Date());

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export class DiscordService {
  constructor(store) {
    this.store = store;
    this.client = null;
    this.ready = false;
    this.enabled = Boolean(process.env.DISCORD_TOKEN);
  }

  async start() {
    if (!this.enabled) {
      console.log("Discord disabled: DISCORD_TOKEN is empty.");
      return;
    }

    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

    this.client.once(Events.ClientReady, async (client) => {
      this.ready = true;
      console.log(`Discord bot logged in as ${client.user.tag}`);
      await this.registerCommands().catch((error) => {
        console.warn(`Could not register slash commands: ${error.message}`);
      });
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const data = this.store.snapshot();
      if (["upcoming", "naechste"].includes(interaction.commandName)) {
        const upcoming = listUpcomingTodayTomorrow(data.series, data.settings);
        const message = buildUpcomingSummary(upcoming, data.settings, data.settings.summaryLimit);
        await interaction.reply(messagePayload(message));
        return;
      }

      if (interaction.commandName === "shedule") {
        const day = normalizeReleaseDay(interaction.options.getString("day", true));
        const releases = listReleasesForWeekday(data.series, data.settings, day);
        const message = buildWeekdayScheduleSummary(releases, data.settings, day);
        await interaction.reply(mentionUserPayload(message, interaction.user.id));
      }
    });

    await this.client.login(process.env.DISCORD_TOKEN);
  }

  async registerCommands() {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId || !process.env.DISCORD_TOKEN) return;

    const commands = [
      new SlashCommandBuilder()
        .setName("upcoming")
        .setDescription("Shows upcoming series episodes from the web panel.")
        .toJSON(),
      new SlashCommandBuilder()
        .setName("shedule")
        .setDescription("Shows releases for a selected weekday.")
        .addStringOption((option) =>
          option
            .setName("day")
            .setDescription("Weekday to show.")
            .setRequired(true)
            .addChoices(...WEEKDAYS.map((day) => ({ name: day.label, value: day.key })))
        )
        .toJSON()
    ];

    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const configuredGuildIds = normalizeChannelIds((process.env.DISCORD_GUILD_ID || "").split(","));
    const guildIds = normalizeChannelIds([...configuredGuildIds, ...this.client.guilds.cache.keys()]);

    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    }

    console.log(`Discord slash commands registered in ${guildIds.length} guild(s).`);
  }

  async listTextChannels() {
    if (!this.enabled || !this.ready || !this.client) return [];

    const groups = await Promise.all(
      [...this.client.guilds.cache.values()].map(async (guild) => {
        const member = guild.members.me;
        const channels = [...guild.channels.cache.values()]
          .filter((channel) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
          .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
          .map((channel) => {
            const permissions = channel.permissionsFor(member);
            return {
              id: channel.id,
              name: channel.name,
              type: channel.type,
              kind: "text",
              canView: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)),
              canSend: Boolean(permissions?.has(PermissionFlagsBits.SendMessages))
            };
          });

        const activeThreads = await guild.channels.fetchActiveThreads().catch(() => ({ threads: new Map() }));
        const forumPosts = [...activeThreads.threads.values()]
          .filter((thread) => [ChannelType.GuildForum, ChannelType.GuildMedia].includes(thread.parent?.type))
          .sort((a, b) => (a.parent?.rawPosition ?? 0) - (b.parent?.rawPosition ?? 0) || a.name.localeCompare(b.name))
          .map((thread) => {
            const permissions = thread.permissionsFor(member);
            return {
              id: thread.id,
              name: thread.name,
              parentName: thread.parent?.name || "Forum",
              type: thread.type,
              kind: "forum-post",
              canView: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)),
              canSend: Boolean(
                permissions?.has(PermissionFlagsBits.SendMessagesInThreads) ||
                  permissions?.has(PermissionFlagsBits.SendMessages)
              )
            };
          });

        return {
          id: guild.id,
          name: guild.name,
          channels: [...channels, ...forumPosts]
        };
      })
    );

    return groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listMentionRoles() {
    if (!this.enabled || !this.ready || !this.client) return [];

    const groups = await Promise.all(
      [...this.client.guilds.cache.values()].map(async (guild) => {
        const fetched = await guild.roles.fetch().catch(() => null);
        const roles = fetched || guild.roles.cache;
        const canMentionUnmentionable = Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone));

        return {
          id: guild.id,
          name: guild.name,
          roles: [...roles.values()]
            .filter((role) => role.id !== guild.id && !role.managed)
            .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
            .map((role) => ({
              id: role.id,
              name: role.name,
              color: role.hexColor && role.hexColor !== "#000000" ? role.hexColor : "#8bb4ff",
              mentionable: Boolean(role.mentionable),
              canMention: Boolean(role.mentionable || canMentionUnmentionable)
            }))
        };
      })
    );

    return groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendToChannel(channelId, content, options = {}) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Discord channel ${channelId} could not be fetched.`);
    }

    if ([ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) {
      throw new Error(`Select an existing forum post/thread, not the forum channel ${channelId}.`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Discord channel ${channelId} is not text based or could not be fetched.`);
    }

    const mentionRoleIds = await mentionRoleIdsForChannel(channel, options.mentionRoleIds);
    return channel.send(withRoleMentions(content, mentionRoleIds));
  }

  async post(content, channelIds = getChannelIds(this.store), options = {}) {
    if (!this.enabled) throw new Error("DISCORD_TOKEN is empty.");
    if (!this.ready) throw new Error("Discord bot is not ready yet.");
    const targets = normalizeChannelIds(channelIds);
    if (!targets.length) throw new Error("Discord channel id is missing.");

    const sent = [];
    const failed = [];

    for (const channelId of targets) {
      try {
        const message = await this.sendToChannel(channelId, content, options);
        sent.push({ channelId, messageId: message.id });
      } catch (error) {
        failed.push({ channelId, message: error.message });
      }
    }

    if (!sent.length) {
      throw new Error(failed.map((item) => `${item.channelId}: ${item.message}`).join("; "));
    }

    if (failed.length) {
      console.warn(`Discord post partially failed: ${failed.map((item) => `${item.channelId}: ${item.message}`).join("; ")}`);
    }

    return { sent, failed };
  }
}

export function createDiscordService(store) {
  return new DiscordService(store);
}
