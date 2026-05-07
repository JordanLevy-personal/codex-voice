import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectStore = new URL("../src/main/projectStore.ts", import.meta.url);
const mainIndex = new URL("../src/main/index.ts", import.meta.url);
const preload = new URL("../src/preload/index.ts", import.meta.url);
const rendererMain = new URL("../src/renderer/src/main.tsx", import.meta.url);
const realtimeClient = new URL("../src/renderer/src/realtimeClient.ts", import.meta.url);

test("Codex voice projects can be opened from arbitrary existing folders", async () => {
  const [storeSource, indexSource, preloadSource, rendererSource, realtimeClientSource] = await Promise.all([
    readFile(projectStore, "utf8"),
    readFile(mainIndex, "utf8"),
    readFile(preload, "utf8"),
    readFile(rendererMain, "utf8"),
    readFile(realtimeClient, "utf8"),
  ]);

  assert.match(storeSource, /async openProjectFolder\(folderPath: string, displayName\?: string\)/);
  assert.match(storeSource, /path\.resolve\(folderPath\)/);
  assert.match(storeSource, /getProjectByFolderPath\(resolvedFolderPath/);
  assert.match(indexSource, /dialog\.showOpenDialog/);
  assert.match(preloadSource, /openProjectFolder: \(folderPath\?: string, name\?: string\)/);
  assert.match(rendererSource, /window\.codexVoice\.openProjectFolder/);
  assert.match(realtimeClientSource, /optionalString\(args\.folderPath\)/);
});
