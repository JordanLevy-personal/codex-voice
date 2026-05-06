export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexPermissionMode = "default" | "auto-review" | "full-access";

export type CodexPermissionProfile = {
  mode: CodexPermissionMode;
  displayName: string;
  description: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
};

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = "default";

export const CODEX_PERMISSION_PROFILES: CodexPermissionProfile[] = [
  {
    mode: "default",
    displayName: "Default permissions",
    description: "Ask when Codex decides approval is needed.",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  {
    mode: "auto-review",
    displayName: "Auto-review",
    description: "Work automatically inside the workspace sandbox.",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  },
  {
    mode: "full-access",
    displayName: "Full access",
    description: "Run without approval prompts or filesystem sandboxing.",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
];

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
  chatPermissionMode: CodexPermissionMode;
  /** Compatibility aliases for older renderer/voice callers. */
  sessionModel: string | null;
  sessionReasoningEffort: ReasoningEffort | null;
  sessionPermissionMode: CodexPermissionMode;
  nextTurnModel: string | null;
  nextTurnReasoningEffort: ReasoningEffort | null;
  nextTurnPermissionMode: CodexPermissionMode | null;
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
  activeTurnPermissionMode: CodexPermissionMode | null;
  defaultModel: string | null;
  defaultReasoningEffort: ReasoningEffort | null;
  defaultPermissionMode: CodexPermissionMode;
  models: CodexModelSummary[];
};

export type VoiceChat = {
  id: string;
  displayName: string;
  codexThreadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  permissionMode: CodexPermissionMode;
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
  permissionMode: CodexPermissionMode;
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

export type PendingRequestKind =
  | "approval"
  | "question"
  | "elicitation"
  | "tool"
  | "auth"
  | "unknown";

export type PendingRequestDetail = {
  label: string;
  value: string;
};

export type PendingRequestQuestionOption = {
  label: string;
  description: string;
};

export type PendingRequestQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingRequestQuestionOption[] | null;
};

export type PendingCodexRequest = {
  kind: PendingRequestKind;
  requestId: number | string;
  method: string;
  sessionId?: string;
  chatId?: string;
  sessionName?: string;
  chatName?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  subtitle?: string;
  body: string;
  details?: PendingRequestDetail[];
  questions?: PendingRequestQuestion[];
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
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null; permissionMode?: CodexPermissionMode | null },
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
