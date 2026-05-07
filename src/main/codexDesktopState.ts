import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_DESKTOP_STATE_FILE = ".codex-global-state.json";

export const CODEX_DESKTOP_PROJECT_KEYS = [
  "active-workspace-roots",
  "electron-saved-workspace-roots",
  "project-order",
] as const;

export function isCodexDesktopProjectFolder(folderPath: string): boolean {
  const target = normalizeFolderPath(folderPath);
  if (!target) return false;
  return codexDesktopProjectFolders().some((candidate) => normalizeFolderPath(candidate) === target);
}

export function codexDesktopProjectFolders(): string[] {
  const state = readCodexDesktopGlobalState();
  if (!state) return [];

  const folders = new Set<string>();
  for (const key of CODEX_DESKTOP_PROJECT_KEYS) {
    const value = state[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) folders.add(item);
    }
  }
  return [...folders];
}

function readCodexDesktopGlobalState(): Record<string, unknown> | null {
  const statePath = path.join(codexHome(), CODEX_DESKTOP_STATE_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function normalizeFolderPath(folderPath: string): string | null {
  const trimmed = folderPath.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
