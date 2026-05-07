import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererMain = new URL("../src/renderer/src/main.tsx", import.meta.url);
const realtimeClient = new URL("../src/renderer/src/realtimeClient.ts", import.meta.url);

test("Realtime narrates completed work from final Codex output instead of generic turn completion", async () => {
  const [mainSource, clientSource] = await Promise.all([
    readFile(rendererMain, "utf8"),
    readFile(realtimeClient, "utf8"),
  ]);

  assert.match(
    mainSource,
    /event\.source === "codex" && event\.kind === "turn\/finalOutput"[\s\S]*summarizeCodexTurnOutput\(event\.raw as CodexTurnOutput\)/,
  );
  assert.doesNotMatch(mainSource, /notifyCodexTurnCompleted\(event\)/);
  assert.match(clientSource, /summarizeCodexTurnOutput\(output: CodexTurnOutput\): void/);
  assert.match(clientSource, /Summarize the completed Codex work for the user/);
});
