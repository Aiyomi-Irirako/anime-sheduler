import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, Events } from 'discord.js';
import { createDiscordService } from '../src/discordBot.js';

async function setup(t, options) {
  const originalToken = process.env.DISCORD_TOKEN;
  t.after(() => {
    if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalToken;
  });
  process.env.DISCORD_TOKEN = 'offline-test-token';
  const store = { getSettings: () => ({ discordChannelIds: ['111111111111111111'] }),
    snapshot: () => ({ settings: { timeZone: 'Europe/Berlin' }, series: [] }) };
  const discord = createDiscordService(store, options);
  t.after(() => discord.client?.destroy());
  let logins = 0;
  let registrations = 0;
  t.mock.method(console, 'log', () => {});
  t.mock.method(Client.prototype, 'login', async function () {
    logins += 1;
    this.emit(Events.ClientReady, { user: { tag: 'Offline test' } });
  });
  t.mock.method(discord, 'registerCommands', async () => { registrations += 1; });
  await discord.start();
  await new Promise(setImmediate);
  return { discord, logins, registrations };
}

test('manual-only Discord connection logs in without registering or responding to slash commands', async (t) => {
  const { discord, logins, registrations } = await setup(t, { commandsEnabled: false });
  assert.equal(logins, 1);
  assert.equal(discord.ready, true);
  assert.equal(registrations, 0);
  let replies = 0;
  discord.client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: 'upcoming', reply: async () => { replies += 1; }
  });
  await new Promise(setImmediate);
  assert.equal(replies, 0);
  const messages = [];
  t.mock.method(discord, 'sendToChannel', async (channelId, content) => {
    messages.push({ channelId, content });
    return { id: 'manual-message' };
  });
  const result = await discord.post('Manual test');
  assert.equal(result.sent.length, 1);
  assert.deepEqual(messages, [{ channelId: '111111111111111111', content: 'Manual test' }]);
});

test('normal Discord connection continues registering and handling slash commands', async (t) => {
  const { discord, registrations } = await setup(t);
  assert.equal(registrations, 1);
  let replies = 0;
  discord.client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true, commandName: 'upcoming', reply: async () => { replies += 1; }
  });
  await new Promise(setImmediate);
  assert.equal(replies, 1);
});
