import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { clearOpenAiApiKey, saveOpenAiApiKey } from "./apiKeyStore";
import appIcon from "./assets/app-icon.png?asset";
import { CodexBridge } from "./codexBridge";
import { VoiceCodexOrchestrator } from "./orchestrator";
import { SessionStore } from "./sessionStore";
import type {
  ApprovalDecision,
  AppEvent,
  CodexPermissionMode,
  CodexSettingsScope,
  ReasoningEffort,
  ToolQuestionAnswer,
} from "../shared/types";

const maxBufferedEvents = 250;

let voiceWindow: BrowserWindow | null = null;
let debugWindow: BrowserWindow | null = null;
let orchestrator: VoiceCodexOrchestrator | null = null;
let bufferedEvents: AppEvent[] = [];

type RendererWindowKind = "voice" | "debug";

function createVoiceWindow(): void {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.show();
    voiceWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 444,
    height: 661,
    minWidth: 410,
    minHeight: 640,
    title: "Codex Voice",
    icon: appIcon,
    backgroundColor: "#121212",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  voiceWindow = window;

  loadRenderer(window, "voice");
  window.webContents.setZoomFactor(0.85);
  window.on("closed", () => {
    if (voiceWindow === window) voiceWindow = null;
  });
}

function createDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show();
    debugWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    title: "Codex Voice Debug",
    icon: appIcon,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugWindow = window;

  loadRenderer(window, "debug");
  window.on("closed", () => {
    if (debugWindow === window) debugWindow = null;
  });
}

function loadRenderer(window: BrowserWindow, kind: RendererWindowKind): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    rendererUrl.searchParams.set("window", kind);
    void window.loadURL(rendererUrl.toString());
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"), {
      query: { window: kind },
    });
  }
}

function appWindows(): BrowserWindow[] {
  return [voiceWindow, debugWindow].filter(
    (window): window is BrowserWindow => Boolean(window && !window.isDestroyed()),
  );
}

function broadcastToAppWindows(channel: string, payload: unknown): void {
  for (const window of appWindows()) {
    window.webContents.send(channel, payload);
  }
}

function recordEvent(event: AppEvent): void {
  bufferedEvents = [event, ...bufferedEvents].slice(0, maxBufferedEvents);
}

function publishEvent(event: AppEvent): void {
  recordEvent(event);
  broadcastToAppWindows("app:event", event);
}

function normalizeAppEvent(payload: AppEvent): AppEvent {
  const source =
    payload.source === "app" || payload.source === "codex" || payload.source === "realtime"
      ? payload.source
      : "app";
  return {
    at: typeof payload.at === "string" && payload.at ? payload.at : new Date().toISOString(),
    source,
    kind: typeof payload.kind === "string" && payload.kind ? payload.kind : "event",
    message: typeof payload.message === "string" ? payload.message : String(payload.message ?? ""),
    ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
  };
}

async function boot(): Promise<void> {
  const store = new SessionStore();
  const codex = new CodexBridge();
  orchestrator = new VoiceCodexOrchestrator(store, codex);

  orchestrator.on("state", (state) => broadcastToAppWindows("app:state", state));
  orchestrator.on("event", (event) => publishEvent(normalizeAppEvent(event)));

  createVoiceWindow();
  await orchestrator.initialize();
}

function requireOrchestrator(): VoiceCodexOrchestrator {
  if (!orchestrator) throw new Error("App is still starting.");
  return orchestrator;
}

app.whenReady().then(() => {
  app.dock?.setIcon(appIcon);
  registerIpc();
  void boot();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createVoiceWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  orchestrator?.shutdown();
});

function registerIpc(): void {
  ipcMain.handle("app:getState", () => requireOrchestrator().state());
  ipcMain.handle("app:openDebugWindow", () => {
    createDebugWindow();
  });
  ipcMain.handle("app:getEvents", () => bufferedEvents);
  ipcMain.handle("app:clearEvents", () => {
    bufferedEvents = [];
  });
  ipcMain.handle("app:logEvent", (_event, payload: AppEvent) => {
    publishEvent(normalizeAppEvent(payload));
  });
  ipcMain.handle("sessions:create", (_event, payload: { name?: string }) =>
    requireOrchestrator().createSession(payload.name),
  );
  ipcMain.handle("sessions:resume", (_event, payload: { sessionId: string }) =>
    requireOrchestrator().resumeSession(payload.sessionId),
  );
  ipcMain.handle("sessions:archive", (_event, payload: { sessionId: string }) =>
    requireOrchestrator().archiveSession(payload.sessionId),
  );
  ipcMain.handle("sessions:restore", (_event, payload: { sessionId: string }) =>
    requireOrchestrator().restoreSession(payload.sessionId),
  );
  ipcMain.handle("chats:create", (_event, payload: { name: string; sessionId?: string }) =>
    requireOrchestrator().createChat(payload.name, payload.sessionId),
  );
  ipcMain.handle("chats:switch", (_event, payload: { chatId: string; sessionId?: string }) =>
    requireOrchestrator().switchChat(payload.chatId, payload.sessionId),
  );
  ipcMain.handle("chats:archive", (_event, payload: { chatId: string; sessionId?: string }) =>
    requireOrchestrator().archiveChat(payload.chatId, payload.sessionId),
  );
  ipcMain.handle("chats:restore", (_event, payload: { chatId: string; sessionId?: string }) =>
    requireOrchestrator().restoreChat(payload.chatId, payload.sessionId),
  );
  ipcMain.handle("chats:list", (_event, payload: { sessionId?: string }) =>
    requireOrchestrator().listChats(payload.sessionId),
  );
  ipcMain.handle("chats:show", (_event, payload: { open?: boolean }) =>
    requireOrchestrator().showSessionChats(payload.open),
  );
  ipcMain.handle("chats:status", (_event, payload: { chatId?: string }) =>
    requireOrchestrator().getChatStatus(payload.chatId),
  );
  ipcMain.handle("sessions:summarize", (_event, payload: { sessionId?: string; chatId?: string }) =>
    requireOrchestrator().summarizeSession(payload.sessionId, payload.chatId),
  );
  ipcMain.handle("codex:send", (_event, payload: { text: string; chatId?: string }) =>
    requireOrchestrator().sendToCodex(payload.text, payload.chatId),
  );
  ipcMain.handle("codex:steer", (_event, payload: { text: string; chatId?: string }) =>
    requireOrchestrator().steerCodex(payload.text, payload.chatId),
  );
  ipcMain.handle("codex:interrupt", (_event, payload?: { chatId?: string }) =>
    requireOrchestrator().interruptCodex(payload?.chatId),
  );
  ipcMain.handle(
    "codex:setSettings",
    (
      _event,
      payload: {
        settings: {
          model?: string | null;
          reasoningEffort?: ReasoningEffort | null;
          permissionMode?: CodexPermissionMode | null;
        };
        scope: CodexSettingsScope;
      },
    ) => requireOrchestrator().setCodexSettings(payload.settings, payload.scope),
  );
  ipcMain.handle(
    "codex:answerApproval",
    (_event, payload: { requestId: string | number; decision: ApprovalDecision }) =>
      requireOrchestrator().answerApproval(payload.requestId, payload.decision),
  );
  ipcMain.handle(
    "codex:answerToolQuestion",
    (_event, payload: { requestId: string | number; answers: ToolQuestionAnswer[] }) =>
      requireOrchestrator().answerToolQuestion(payload.requestId, payload.answers),
  );
  ipcMain.handle("settings:saveOpenAiApiKey", (_event, payload: { apiKey: string }) => {
    saveOpenAiApiKey(payload.apiKey);
  });
  ipcMain.handle("settings:clearOpenAiApiKey", () => {
    clearOpenAiApiKey();
  });
  ipcMain.handle("realtime:createClientSecret", () =>
    requireOrchestrator().createRealtimeClientSecret(),
  );
}
