import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  type CodexPermissionMode,
  type ReasoningEffort,
  type VoiceChat,
  type VoiceSession,
} from "../shared/types";

type SessionIndex = {
  version: 1;
  sessions: VoiceSession[];
};

type ListSessionsOptions = {
  includeArchived?: boolean;
};

const INDEX_FILE = ".codex-voice-index.json";
const SESSION_FILE = ".codex-voice-session.json";

export class SessionStore {
  readonly baseFolder: string;
  private readonly indexPath: string;
  private readonly lockPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(baseFolder = path.join(app.getPath("documents"), "Codex Voice Sessions")) {
    this.baseFolder = baseFolder;
    this.indexPath = path.join(baseFolder, INDEX_FILE);
    this.lockPath = `${this.indexPath}.lock`;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.baseFolder, { recursive: true });
    await this.enqueueMutation(async () => {
      if (!existsSync(this.indexPath)) {
        await this.writeIndex({ version: 1, sessions: await this.readSessionsFromFolders() });
        return;
      }
      const index = await this.readIndexFile();
      if (!index) {
        await this.writeIndex({ version: 1, sessions: await this.readSessionsFromFolders() });
        return;
      }
      if (index.sessions.length === 0) {
        const sessions = await this.readSessionsFromFolders();
        if (sessions.length > 0) {
          await this.writeIndex({ version: 1, sessions });
        }
      }
    });
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<VoiceSession[]> {
    const index = await this.readIndex();
    return index.sessions
      .filter((session) => options.includeArchived || !session.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listArchivedSessions(): Promise<VoiceSession[]> {
    const sessions = await this.listSessions({ includeArchived: true });
    return sessions.filter((session) => session.archivedAt);
  }

  async getSession(id: string, options: ListSessionsOptions = {}): Promise<VoiceSession | null> {
    const sessions = await this.listSessions(options);
    return sessions.find((session) => session.id === id) ?? null;
  }

  async getMostRecent(): Promise<VoiceSession | null> {
    const sessions = await this.listSessions();
    return sessions[0] ?? null;
  }

  async createSession(displayName?: string): Promise<VoiceSession> {
    const now = new Date();
    const id = randomUUID();
    const safeName = sanitizeSessionName(displayName || "Voice Session");
    const folderName = `${formatFolderTimestamp(now)} - ${safeName}`;
    const folderPath = await this.uniqueFolderPath(folderName);

    await mkdir(folderPath, { recursive: true });

    const session: VoiceSession = {
      id,
      displayName: displayName?.trim() || "Voice Session",
      folderPath,
      activeChatId: null,
      chats: [],
      codexThreadId: null,
      model: null,
      reasoningEffort: null,
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      archivedAt: null,
      lastSummary: null,
      lastStatus: "Created session folder.",
    };

    await this.upsertSession(session);
    return session;
  }

  async upsertSession(session: VoiceSession): Promise<VoiceSession> {
    return this.enqueueMutation(async () => {
      await mkdir(session.folderPath, { recursive: true });
      const index = await this.readIndex();
      const nextSession = { ...session, updatedAt: new Date().toISOString() };
      const nextSessions = [
        nextSession,
        ...index.sessions.filter((existing) => existing.id !== session.id),
      ];
      await this.writeJsonAtomic(path.join(session.folderPath, SESSION_FILE), nextSession);
      await this.writeIndex({ version: 1, sessions: nextSessions });
      return nextSession;
    });
  }

  async updateSession(id: string, patch: Partial<VoiceSession>): Promise<VoiceSession> {
    const existing = await this.getSession(id);
    if (!existing) {
      throw new Error(`Unknown voice session: ${id}`);
    }
    return this.upsertSession({ ...existing, ...patch });
  }

  async archiveSession(id: string): Promise<VoiceSession> {
    const existing = await this.getSession(id, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice session: ${id}`);
    }
    if (existing.archivedAt) return existing;
    return this.upsertSession({
      ...existing,
      archivedAt: new Date().toISOString(),
      lastStatus: "Archived session.",
    });
  }

  async restoreSession(id: string): Promise<VoiceSession> {
    const existing = await this.getSession(id, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice session: ${id}`);
    }
    return this.upsertSession({
      ...existing,
      archivedAt: null,
      lastStatus: "Restored session.",
    });
  }

  async addChat(
    sessionId: string,
    displayName: string,
    codexThreadId: string,
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null; permissionMode?: CodexPermissionMode } = {},
  ): Promise<VoiceSession> {
    const existing = await this.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown voice session: ${sessionId}`);
    }

    const now = new Date().toISOString();
    const model = settings.model ?? existing.model ?? DEFAULT_CODEX_MODEL;
    const reasoningEffort =
      settings.reasoningEffort ?? existing.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    const permissionMode = settings.permissionMode ?? existing.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    const chat: VoiceChat = {
      id: randomUUID(),
      displayName: displayName.trim() || "New chat",
      codexThreadId,
      model,
      reasoningEffort,
      permissionMode,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastSummary: null,
      lastStatus: "Codex thread started.",
    };

    return this.upsertSession({
      ...existing,
      activeChatId: chat.id,
      codexThreadId,
      chats: [...existing.chats, chat],
      lastStatus: `Active chat: ${chat.displayName}`,
    });
  }

  async archiveChat(sessionId: string, chatId: string): Promise<VoiceSession> {
    return this.setChatArchived(sessionId, chatId, new Date().toISOString());
  }

  async restoreChat(sessionId: string, chatId: string): Promise<VoiceSession> {
    return this.setChatArchived(sessionId, chatId, null);
  }

  async setActiveChat(sessionId: string, chatId: string): Promise<VoiceSession> {
    const existing = await this.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown voice session: ${sessionId}`);
    }
    const chat = existing.chats.find((candidate) => candidate.id === chatId);
    if (!chat) {
      throw new Error(`Unknown chat: ${chatId}`);
    }
    return this.upsertSession({
      ...existing,
      activeChatId: chat.id,
      codexThreadId: chat.codexThreadId,
      lastStatus: `Active chat: ${chat.displayName}`,
    });
  }

  async updateChat(sessionId: string, chatId: string, patch: Partial<VoiceChat>): Promise<VoiceSession> {
    const existing = await this.getSession(sessionId);
    if (!existing) {
      throw new Error(`Unknown voice session: ${sessionId}`);
    }
    const now = new Date().toISOString();
    let activeThreadId = existing.codexThreadId;
    const chats = existing.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      const updated = { ...chat, ...patch, updatedAt: now };
      if (existing.activeChatId === chatId) activeThreadId = updated.codexThreadId;
      return updated;
    });
    if (!chats.some((chat) => chat.id === chatId)) {
      throw new Error(`Unknown chat: ${chatId}`);
    }
    return this.upsertSession({
      ...existing,
      chats,
      codexThreadId: activeThreadId,
      lastStatus: patch.lastStatus ?? existing.lastStatus,
      lastSummary: patch.lastSummary ?? existing.lastSummary,
    });
  }

  private async setChatArchived(
    sessionId: string,
    chatId: string,
    archivedAt: string | null,
  ): Promise<VoiceSession> {
    const existing = await this.getSession(sessionId, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice session: ${sessionId}`);
    }

    const now = new Date().toISOString();
    let changed = false;
    const chats = existing.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      changed = true;
      return {
        ...chat,
        archivedAt,
        updatedAt: now,
        lastStatus: archivedAt ? "Archived chat." : "Restored chat.",
      };
    });
    if (!changed) {
      throw new Error(`Unknown chat: ${chatId}`);
    }

    const currentActiveChat =
      existing.activeChatId && chats.find((chat) => chat.id === existing.activeChatId && !chat.archivedAt)
        ? existing.activeChatId
        : null;
    const restoredTarget = !archivedAt ? chats.find((chat) => chat.id === chatId) ?? null : null;
    const activeChatId =
      currentActiveChat ??
      (restoredTarget && !restoredTarget.archivedAt ? restoredTarget.id : null) ??
      chats.find((chat) => !chat.archivedAt)?.id ??
      null;
    const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) ?? null : null;

    return this.upsertSession({
      ...existing,
      activeChatId,
      codexThreadId: activeChat?.codexThreadId ?? null,
      chats,
      lastStatus: archivedAt ? "Archived chat." : "Restored chat.",
    });
  }

  private async uniqueFolderPath(folderName: string): Promise<string> {
    let candidate = path.join(this.baseFolder, folderName);
    let suffix = 2;
    while (existsSync(candidate)) {
      candidate = path.join(this.baseFolder, `${folderName} ${suffix}`);
      suffix += 1;
    }
    return candidate;
  }

  private async readIndex(): Promise<SessionIndex> {
    await mkdir(this.baseFolder, { recursive: true });
    const index = await this.readIndexFile();
    if (index) return index;
    return { version: 1, sessions: await this.readSessionsFromFolders() };
  }

  private async readIndexFile(): Promise<SessionIndex | null> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as SessionIndex;
      return {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSession) : [],
      };
    } catch {
      return null;
    }
  }

  private async writeIndex(index: SessionIndex): Promise<void> {
    await mkdir(this.baseFolder, { recursive: true });
    await this.writeJsonAtomic(this.indexPath, index);
  }

  private async readSessionsFromFolders(): Promise<VoiceSession[]> {
    const entries = await readdir(this.baseFolder, { withFileTypes: true });
    const sessions: VoiceSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionPath = path.join(this.baseFolder, entry.name, SESSION_FILE);
      if (!existsSync(sessionPath)) continue;
      try {
        const session = normalizeSession(JSON.parse(await readFile(sessionPath, "utf8")));
        sessions.push(session);
      } catch {
        // Ignore malformed sidecar files; the debug UI should remain bootable.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
      await rename(tempPath, filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup; preserve the original error.
      }
      throw error;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(
      () => this.withMutationLock(operation),
      () => this.withMutationLock(operation),
    );
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutationLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireMutationLock(): Promise<() => Promise<void>> {
    const staleAfterMs = 30_000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        return async () => {
          try {
            await rmdir(this.lockPath);
          } catch {
            // A stale-lock cleanup race should not hide the successful write.
          }
        };
      } catch (error) {
        if (!isErrorWithCode(error, "EEXIST")) throw error;
        try {
          const lock = await stat(this.lockPath);
          if (Date.now() - lock.mtimeMs > staleAfterMs) {
            await rmdir(this.lockPath);
            continue;
          }
        } catch (lockError) {
          if (!isErrorWithCode(lockError, "ENOENT")) throw lockError;
        }
        await delay(25);
      }
    }
  }
}

function normalizeSession(value: unknown): VoiceSession {
  const session = value as VoiceSession & {
    codexThreadId?: string | null;
    activeChatId?: string | null;
    chats?: VoiceChat[];
  };
  const createdAt = stringOrNow(session.createdAt);
  const updatedAt = stringOrNow(session.updatedAt);
  const legacyThreadId = stringOrNull(session.codexThreadId);
  const legacyModel = stringOrNull(session.model) ?? DEFAULT_CODEX_MODEL;
  const legacyReasoningEffort =
    reasoningEffortOrNull(session.reasoningEffort) ?? DEFAULT_CODEX_REASONING_EFFORT;
  const legacyPermissionMode = permissionModeOrDefault(session.permissionMode);
  let chats = Array.isArray(session.chats)
    ? session.chats
        .map((chat) => normalizeChat(chat, createdAt, updatedAt, legacyModel, legacyReasoningEffort, legacyPermissionMode))
        .filter((chat) => chat.id)
    : [];

  if (chats.length === 0 && legacyThreadId) {
    chats = [
      {
        id: `${session.id}-main`,
        displayName: "Main task",
        codexThreadId: legacyThreadId,
        model: legacyModel,
        reasoningEffort: legacyReasoningEffort,
        permissionMode: legacyPermissionMode,
        createdAt,
        updatedAt,
        archivedAt: null,
        lastSummary: session.lastSummary ?? null,
        lastStatus: session.lastStatus ?? "Codex thread started.",
      },
    ];
  }

  const unarchivedChats = chats.filter((chat) => !chat.archivedAt);
  const activeChatId =
    stringOrNull(session.activeChatId) && unarchivedChats.some((chat) => chat.id === session.activeChatId)
      ? session.activeChatId
      : unarchivedChats[0]?.id ?? null;
  const activeChat = unarchivedChats.find((chat) => chat.id === activeChatId) ?? null;

  return {
    ...session,
    createdAt,
    updatedAt,
    archivedAt: stringOrNull(session.archivedAt),
    activeChatId,
    chats,
    codexThreadId: activeChat?.codexThreadId ?? null,
    model: stringOrNull(session.model),
    reasoningEffort: reasoningEffortOrNull(session.reasoningEffort),
    permissionMode: permissionModeOrDefault(session.permissionMode),
  };
}

function normalizeChat(
  value: unknown,
  fallbackCreatedAt: string,
  fallbackUpdatedAt: string,
  fallbackModel: string,
  fallbackReasoningEffort: ReasoningEffort,
  fallbackPermissionMode: CodexPermissionMode,
): VoiceChat {
  const chat = value as VoiceChat & { reasoningEffort?: ReasoningEffort | null; permissionMode?: CodexPermissionMode };
  return {
    id: String(chat.id ?? randomUUID()),
    displayName: String(chat.displayName ?? "Main task"),
    codexThreadId: stringOrNull(chat.codexThreadId),
    model: stringOrNull(chat.model) ?? fallbackModel,
    reasoningEffort: reasoningEffortOrNull(chat.reasoningEffort) ?? fallbackReasoningEffort,
    permissionMode: permissionModeOrDefault(chat.permissionMode, fallbackPermissionMode),
    createdAt: stringOrNow(chat.createdAt, fallbackCreatedAt),
    updatedAt: stringOrNow(chat.updatedAt, fallbackUpdatedAt),
    archivedAt: stringOrNull(chat.archivedAt),
    lastSummary: chat.lastSummary ?? null,
    lastStatus: chat.lastStatus ?? null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reasoningEffortOrNull(value: unknown): ReasoningEffort | null {
  return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? (value as ReasoningEffort)
    : null;
}

function permissionModeOrDefault(value: unknown, fallback = DEFAULT_CODEX_PERMISSION_MODE): CodexPermissionMode {
  return typeof value === "string" && ["default", "auto-review", "full-access"].includes(value)
    ? (value as CodexPermissionMode)
    : fallback;
}

function stringOrNow(value: unknown, fallback = new Date().toISOString()): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSessionName(name: string): string {
  return name
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .replace(/\s/g, "-")
    .toLowerCase() || "voice-session";
}

function formatFolderTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}
