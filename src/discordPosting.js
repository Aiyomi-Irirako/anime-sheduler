import { parseBoolean } from "./utils.js";

export function automaticPostsLocked() {
  return process.env.DISCORD_AUTO_POSTS !== undefined && !parseBoolean(process.env.DISCORD_AUTO_POSTS);
}

export function automaticPostsEnabled(settings = {}) {
  return !automaticPostsLocked() && settings.automaticDiscordPostsEnabled !== false;
}
