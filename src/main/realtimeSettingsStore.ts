import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REALTIME_MODELS, type RealtimeModel } from "../shared/types";

type RealtimeSettingsFile = {
  version: 1;
  realtimeModel?: RealtimeModel | null;
  updatedAt?: string;
};

const FILE_NAME = "codex-voice-realtime-settings.json";

export function getSavedRealtimeModel(): RealtimeModel | null {
  const model = readFile().realtimeModel;
  return model && isRealtimeModel(model) ? model : null;
}

export function saveRealtimeModel(model: RealtimeModel): RealtimeModel {
  if (!isRealtimeModel(model)) {
    throw new Error(`Unknown Realtime model "${model}".`);
  }
  writeFile({
    version: 1,
    realtimeModel: model,
    updatedAt: new Date().toISOString(),
  });
  return model;
}

function isRealtimeModel(model: string): model is RealtimeModel {
  return REALTIME_MODELS.includes(model as RealtimeModel);
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function readFile(): RealtimeSettingsFile {
  try {
    const filePath = settingsPath();
    if (!existsSync(filePath)) return { version: 1 };
    return JSON.parse(readFileSync(filePath, "utf8")) as RealtimeSettingsFile;
  } catch {
    return { version: 1 };
  }
}

function writeFile(file: RealtimeSettingsFile): void {
  const filePath = settingsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}
