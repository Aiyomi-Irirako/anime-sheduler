import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createWebApp } from "../src/web.js";

function webHeaders() {
  if (!process.env.WEB_PASSWORD) return {};
  const user = process.env.WEB_USER || "admin";
  const token = Buffer.from(`${user}:${process.env.WEB_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

test("persists manual streaming service IDs and preserves them during CSV updates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-service-id-"));
  const filePath = path.join(directory, "db.json");

  try {
    const store = createStore(filePath);
    await store.init();

    const created = await store.upsertSeries({
      title: "Example Series",
      service: "Crunchyroll",
      streamingServiceId: "  G6EXAMPLE123  ",
      scheduleLink: "https://www.livechart.me/anime/12345/schedules"
    });
    assert.equal(created.streamingServiceId, "G6EXAMPLE123");

    const updated = await store.upsertSeries({
      ...created,
      streamingServiceId: "G6UPDATED456"
    });
    assert.equal(updated.streamingServiceId, "G6UPDATED456");

    const idChange = store
      .snapshot()
      .changeLog.find((entry) => entry.changes.some((change) => change.field === "streamingServiceId"));
    assert.deepEqual(idChange.changes.find((change) => change.field === "streamingServiceId"), {
      field: "streamingServiceId",
      label: "Streaming service ID",
      before: "G6EXAMPLE123",
      after: "G6UPDATED456"
    });

    await store.importCsv(
      [
        "title,service,schedulelink,rldate,nextep",
        "Example Series,Crunchyroll,https://www.livechart.me/anime/12345/schedules,Monday 18:00,2"
      ].join("\n"),
      { updateExisting: true, overwriteSchedule: true }
    );
    assert.equal(store.getSeries(created.id).streamingServiceId, "G6UPDATED456");

    const reloaded = createStore(filePath);
    await reloaded.init();
    assert.equal(reloaded.getSeries(created.id).streamingServiceId, "G6UPDATED456");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("accepts and displays a manually entered streaming service ID", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-service-id-web-"));
  const filePath = path.join(directory, "db.json");
  let server;

  try {
    const store = createStore(filePath);
    await store.init();
    const app = createWebApp(store, { enabled: false });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/series`, {
      method: "POST",
      headers: webHeaders(),
      body: new URLSearchParams({
        title: "Web Form Series",
        service: "Animation Digital Network",
        preferredService: "Animation Digital Network",
        streamingServiceId: "adn-series-987",
        episodeBatchSize: "1",
        status: "planned",
        enabled: "on",
        weekly: "on"
      }),
      redirect: "manual"
    });
    assert.equal(response.status, 302);

    const [series] = store.listSeries();
    assert.equal(series.streamingServiceId, "adn-series-987");

    const page = await fetch(`${baseUrl}/series/${encodeURIComponent(series.id)}`, { headers: webHeaders() });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /name="streamingServiceId"/);
    assert.match(html, /value="adn-series-987"/);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
