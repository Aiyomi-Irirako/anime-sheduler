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
import {
  listUpcoming,
  formatEpisodeLine,
  formatEpisodeEntries,
  getMissingTimePostTime
} from "./schedule.js";
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

function releaseTitle(series, release) {
  const entry = formatEpisodeEntries(series, release).find((item) => ["main", "language"].includes(item.kind));
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

export function buildAnnouncement(series, release, settings) {
  const entries = formatEpisodeEntries(series, release);
  const episodeText =
    release?.kind === "language" && Number.isFinite(release.episode)
      ? `Episode ${String(release.episode).padStart(2, "0")}`
      : entries.find((entry) => entry.kind === "main")?.text || "Next episode";
  const languageEpisodes =
    release?.kind === "language" ? [] : entries.filter((entry) => entry.kind === "language").map((entry) => entry.text);
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
      { name: "Episode", value: truncate(episodeText, 1024), inline: true }
    )
    .setFooter({ text: "Series Bot" })
    .setTimestamp(new Date());

  if (postService) {
    embed.addFields({ name: "Service", value: truncate(postService, 1024), inline: true });
  }

  if (languageEpisodes.length) {
    embed.addFields({ name: "Language versions", value: truncate(languageEpisodes.join("\n"), 1024), inline: false });
  }

  if (release?.kind === "language") {
    embed.addFields({ name: "Version", value: truncate(release.languageLabel || release.languageCode, 1024), inline: true });
  }

  if (release?.missingTime) {
    embed.addFields({
      name: "Auto-post time",
      value: `${getMissingTimePostTime(settings)} (time missing fallback)`,
      inline: true
    });
  }

  if (scheduleUrl) {
    embed.setURL(scheduleUrl);
    embed.addFields({ name: "Source", value: `[Open schedule](${scheduleUrl})`, inline: true });
  }

  if (imageUrl) {
    embed.setThumbnail(imageUrl);
  }

  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export function buildUpcomingSummary(items, settings, limit = 12) {
  const visible = items.slice(0, limit);
  if (!visible.length) return "No upcoming episodes found.";

  const lines = visible.map(({ series, release }) => `- ${formatEpisodeLine(series, release, settings)}`);
  return `**Upcoming Episodes**\n${lines.join("\n")}`;
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
      if (!["upcoming", "naechste"].includes(interaction.commandName)) return;

      const data = this.store.snapshot();
      const upcoming = listUpcoming(data.series, data.settings, data.settings.lookaheadDays);
      const message = buildUpcomingSummary(upcoming, data.settings, data.settings.summaryLimit);
      await interaction.reply(message.slice(0, 1900));
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
        .toJSON()
    ];

    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    const configuredGuildIds = normalizeChannelIds((process.env.DISCORD_GUILD_ID || "").split(","));
    const guildIds = normalizeChannelIds([...configuredGuildIds, ...this.client.guilds.cache.keys()]);

    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    }

    console.log(`Discord slash command /upcoming registered in ${guildIds.length} guild(s).`);
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

  async sendToChannel(channelId, content) {
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

    return channel.send(messagePayload(content));
  }

  async post(content, channelIds = getChannelIds(this.store)) {
    if (!this.enabled) throw new Error("DISCORD_TOKEN is empty.");
    if (!this.ready) throw new Error("Discord bot is not ready yet.");
    const targets = normalizeChannelIds(channelIds);
    if (!targets.length) throw new Error("Discord channel id is missing.");

    const sent = [];
    const failed = [];

    for (const channelId of targets) {
      try {
        const message = await this.sendToChannel(channelId, content);
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
