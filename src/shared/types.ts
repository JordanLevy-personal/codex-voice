export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "medium";

export type CodexModelSummary = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
};

export type CodexSettingsScope = "chat" | "session" | "nextTurn";

export type CodexSettings = {
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  /** Compatibility aliases for older renderer/voice callers. */
  sessionModel: string | null;
  sessionReasoningEffort: ReasoningEffort | null;
  nextTurnModel: string | null;
  nextTurnReasoningEffort: ReasoningEffort | null;
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
  defaultModel: string | null;
  defaultReasoningEffort: ReasoningEffort | null;
  models: CodexModelSummary[];
};

export type VoiceChat = {
  id: string;
  displayName: string;
  codexThreadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastSummary: string | null;
  lastStatus: string | null;
};

export type VoiceSession = {
  id: string;
  displayName: string;
  folderPath: string;
  activeChatId: string | null;
  chats: VoiceChat[];
  /** Compatibility alias for the active chat's Codex thread id. */
  codexThreadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastSummary: string | null;
  lastStatus: string | null;
};

export type CodexChatRuntime = {
  chatId: string;
  threadId: string | null;
  displayName: string;
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
};

export type CodexRuntimeState = {
  ready: boolean;
  activeSessionId: string | null;
  activeChatId: string | null;
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  chats: CodexChatRuntime[];
  showSessionChats: boolean;
};

export type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type PendingCodexRequest = {
  requestId: number | string;
  method: string;
  sessionId?: string;
  chatId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  body: string;
  options?: string[];
  raw: unknown;
};

export type AppState = {
  baseFolder: string;
  sessions: VoiceSession[];
  archivedSessions: VoiceSession[];
  activeSession: VoiceSession | null;
  runtime: CodexRuntimeState;
  codexSettings: CodexSettings;
  realtime: {
    available: boolean;
    model: string;
    voice: string;
    reason: string | null;
    apiKeySource: "environment" | "saved" | null;
    apiKeyEncrypted: boolean;
  };
};

export type CodexActionResult = {
  kind: "turn" | "command";
  message: string;
  turnId: string | null;
  session: VoiceSession | null;
  chat: VoiceChat | null;
};

export type AppEvent = {
  at: string;
  source: "app" | "codex" | "realtime";
  kind: string;
  message: string;
  raw?: unknown;
};

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ToolQuestionAnswer = {
  questionId: string;
  answers: string[];
};

export type RealtimeClientSecret = {
  value: string;
  expiresAt?: number;
  model: string;
  voice: string;
};

export type CodexVoiceApi = {
  getState(): Promise<AppState>;
  openDebugWindow(): Promise<void>;
  getEvents(): Promise<AppEvent[]>;
  clearEvents(): Promise<void>;
  logEvent(event: AppEvent): Promise<void>;
  createSession(name?: string): Promise<VoiceSession>;
  resumeSession(sessionId: string): Promise<VoiceSession>;
  archiveSession(sessionId: string): Promise<VoiceSession>;
  restoreSession(sessionId: string): Promise<VoiceSession>;
  createChat(name: string, sessionId?: string): Promise<VoiceSession>;
  switchChat(chatId: string, sessionId?: string): Promise<VoiceSession>;
  archiveChat(chatId: string, sessionId?: string): Promise<VoiceSession>;
  restoreChat(chatId: string, sessionId?: string): Promise<VoiceSession>;
  listChats(sessionId?: string): Promise<VoiceChat[]>;
  showSessionChats(open?: boolean): Promise<void>;
  summarizeSession(sessionId?: string, chatId?: string): Promise<string>;
  sendToCodex(text: string, chatId?: string): Promise<CodexActionResult>;
  steerCodex(text: string, chatId?: string): Promise<{ turnId: string }>;
  interruptCodex(chatId?: string): Promise<void>;
  getChatStatus(chatId?: string): Promise<CodexChatRuntime[]>;
  setCodexSettings(
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null },
    scope: CodexSettingsScope,
  ): Promise<CodexSettings>;
  answerApproval(requestId: string | number, decision: ApprovalDecision): Promise<void>;
  answerToolQuestion(requestId: string | number, answers: ToolQuestionAnswer[]): Promise<void>;
  saveOpenAiApiKey(apiKey: string): Promise<void>;
  clearOpenAiApiKey(): Promise<void>;
  createRealtimeClientSecret(): Promise<RealtimeClientSecret>;
  onAppState(listener: (state: AppState) => void): () => void;
  onAppEvent(listener: (event: AppEvent) => void): () => void;
};
