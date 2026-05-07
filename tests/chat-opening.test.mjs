import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sharedTypes = new URL("../src/shared/types.ts", import.meta.url);
const orchestrator = new URL("../src/main/orchestrator.ts", import.meta.url);
const mainIndex = new URL("../src/main/index.ts", import.meta.url);
const preload = new URL("../src/preload/index.ts", import.meta.url);
const rendererMain = new URL("../src/renderer/src/main.tsx", import.meta.url);
const realtime = new URL("../src/main/realtime.ts", import.meta.url);
const realtimeClient = new URL("../src/renderer/src/realtimeClient.ts", import.meta.url);
const codexDesktopState = new URL("../src/main/codexDesktopState.ts", import.meta.url);

test("Codex voice chats can be opened in the Codex desktop app", async () => {
  const [
    typesSource,
    orchestratorSource,
    indexSource,
    preloadSource,
    rendererSource,
    realtimeSource,
    realtimeClientSource,
    codexDesktopStateSource,
  ] = await Promise.all([
    readFile(sharedTypes, "utf8"),
    readFile(orchestrator, "utf8"),
    readFile(mainIndex, "utf8"),
    readFile(preload, "utf8"),
    readFile(rendererMain, "utf8"),
    readFile(realtime, "utf8"),
    readFile(realtimeClient, "utf8"),
    readFile(codexDesktopState, "utf8"),
  ]);

  assert.match(typesSource, /openChatInCodex\(chatId\?: string, projectId\?: string\)/);
  assert.match(typesSource, /openUrls: string\[\]/);
  assert.match(orchestratorSource, /async openChatInCodex\(chatId\?: string, projectId\?: string\)/);
  assert.match(orchestratorSource, /codex:\/\/threads\/\$\{encodeURIComponent\(threadId\)\}/);
  assert.match(orchestratorSource, /codex:\/\/new\?\$\{params\.toString\(\)\}/);
  assert.match(orchestratorSource, /openUrls = existingThreadId && threadUrl \? \[threadUrl\] : threadUrl \? \[newProjectUrl, threadUrl\] : \[newProjectUrl\]/);
  assert.match(orchestratorSource, /isCodexDesktopProjectFolder\(project\.folderPath\)/);
  assert.match(indexSource, /for \(const \[index, url\] of result\.openUrls\.entries\(\)\)/);
  assert.match(indexSource, /await shell\.openExternal\(url\)/);
  assert.match(indexSource, /await wait\(codexOpenSequenceDelayMs\)/);
  assert.match(indexSource, /"projects:openChatInCodex"/);
  assert.match(preloadSource, /openChatInCodex: \(chatId\?: string, projectId\?: string\)/);
  assert.match(rendererSource, /onOpenChatInCodex\(chat\.id\)/);
  assert.match(realtimeSource, /name: "open_codex_chat"/);
  assert.match(realtimeSource, /use open_codex_chat instead of submit_to_codex/);
  assert.match(realtimeClientSource, /name === "open_codex_chat"/);
  assert.match(codexDesktopStateSource, /CODEX_DESKTOP_PROJECT_KEYS = \[/);
  assert.match(codexDesktopStateSource, /"electron-saved-workspace-roots"/);
  assert.match(codexDesktopStateSource, /"active-workspace-roots"/);
  assert.match(codexDesktopStateSource, /"project-order"/);
});
