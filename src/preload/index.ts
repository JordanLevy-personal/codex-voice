import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvent,
  AppState,
  ApprovalDecision,
  CodexSettingsScope,
  CodexVoiceApi,
  ReasoningEffort,
  ToolQuestionAnswer,
} from "../shared/types";

const api: CodexVoiceApi = {
  getState: () => ipcRenderer.invoke("app:getState"),
  openDebugWindow: () => ipcRenderer.invoke("app:openDebugWindow"),
  getEvents: () => ipcRenderer.invoke("app:getEvents"),
  clearEvents: () => ipcRenderer.invoke("app:clearEvents"),
  logEvent: (event: AppEvent) => ipcRenderer.invoke("app:logEvent", event),
  createSession: (name?: string) => ipcRenderer.invoke("sessions:create", { name }),
  resumeSession: (sessionId: string) => ipcRenderer.invoke("sessions:resume", { sessionId }),
  archiveSession: (sessionId: string) => ipcRenderer.invoke("sessions:archive", { sessionId }),
  restoreSession: (sessionId: string) => ipcRenderer.invoke("sessions:restore", { sessionId }),
  createChat: (name: string, sessionId?: string) => ipcRenderer.invoke("chats:create", { name, sessionId }),
  switchChat: (chatId: string, sessionId?: string) => ipcRenderer.invoke("chats:switch", { chatId, sessionId }),
  archiveChat: (chatId: string, sessionId?: string) => ipcRenderer.invoke("chats:archive", { chatId, sessionId }),
  restoreChat: (chatId: string, sessionId?: string) => ipcRenderer.invoke("chats:restore", { chatId, sessionId }),
  listChats: (sessionId?: string) => ipcRenderer.invoke("chats:list", { sessionId }),
  showSessionChats: (open?: boolean) => ipcRenderer.invoke("chats:show", { open }),
  summarizeSession: (sessionId?: string, chatId?: string) =>
    ipcRenderer.invoke("sessions:summarize", { sessionId, chatId }),
  sendToCodex: (text: string, chatId?: string) => ipcRenderer.invoke("codex:send", { text, chatId }),
  steerCodex: (text: string, chatId?: string) => ipcRenderer.invoke("codex:steer", { text, chatId }),
  interruptCodex: (chatId?: string) => ipcRenderer.invoke("codex:interrupt", { chatId }),
  getChatStatus: (chatId?: string) => ipcRenderer.invoke("chats:status", { chatId }),
  setCodexSettings: (
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null },
    scope: CodexSettingsScope,
  ) => ipcRenderer.invoke("codex:setSettings", { settings, scope }),
  answerApproval: (requestId: string | number, decision: ApprovalDecision) =>
    ipcRenderer.invoke("codex:answerApproval", { requestId, decision }),
  answerToolQuestion: (requestId: string | number, answers: ToolQuestionAnswer[]) =>
    ipcRenderer.invoke("codex:answerToolQuestion", { requestId, answers }),
  saveOpenAiApiKey: (apiKey: string) => ipcRenderer.invoke("settings:saveOpenAiApiKey", { apiKey }),
  clearOpenAiApiKey: () => ipcRenderer.invoke("settings:clearOpenAiApiKey"),
  createRealtimeClientSecret: () => ipcRenderer.invoke("realtime:createClientSecret"),
  onAppState: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on("app:state", handler);
    return () => ipcRenderer.off("app:state", handler);
  },
  onAppEvent: (listener: (event: AppEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, appEvent: AppEvent) => listener(appEvent);
    ipcRenderer.on("app:event", handler);
    return () => ipcRenderer.off("app:event", handler);
  },
};

contextBridge.exposeInMainWorld("codexVoice", api);
