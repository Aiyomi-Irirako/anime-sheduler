import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

test("migrates and persists the preferred schedule language independently", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anime-sheduler-settings-"));
  const filePath = path.join(directory, "db.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        settings: { enabledLanguageCodes: ["fr"] },
        series: [],
        posts: [],
        changeLog: []
      }),
      "utf8"
    );

    const store = createStore(filePath);
    await store.init();
    assert.equal(store.getSettings().preferredScheduleLanguage, "fr");

    await store.updateSettings({
      ...store.getSettings(),
      preferredScheduleLanguage: "en",
      enabledLanguageCodes: "de"
    });
    assert.equal(store.getSettings().preferredScheduleLanguage, "en");
    assert.deepEqual(store.getSettings().enabledLanguageCodes, ["de"]);

    await store.updateSettings({
      ...store.getSettings(),
      preferredScheduleLanguage: ""
    });

    const reloaded = createStore(filePath);
    await reloaded.init();
    assert.equal(reloaded.getSettings().preferredScheduleLanguage, "");
    assert.deepEqual(reloaded.getSettings().enabledLanguageCodes, ["de"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
