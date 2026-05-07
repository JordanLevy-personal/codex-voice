export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexPermissionMode = "default" | "auto-review" | "full-access";
export type RealtimeModel = "gpt-realtime-1.5" | "gpt-realtime-2";

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
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
export const DEFAULT_REALTIME_VOICE = "marin";
export const DEFAULT_REALTIME_REASONING_EFFORT = "low";
export const REALTIME_MODELS: RealtimeModel[] = ["gpt-realtime-1.5", "gpt-realtime-2"];

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

export type CodexSettingsScope = "chat" | "nextTurn";

export type CodexSettings = {
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  chatPermissionMode: CodexPermissionMode;
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

export type CodexTurnOutput = {
  threadId: string;
  turnId: string;
  status: string;
  finalAssistantText: string;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  errorMessage?: string;
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
  lastTurnOutput: CodexTurnOutput | null;
};

export type VoiceProject = {
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
  activeProjectId: string | null;
  activeChatId: string | null;
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  chats: CodexChatRuntime[];
  showProjectChats: boolean;
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
  projectId?: string;
  projectName?: string;
  chatId?: string;
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
  projects: VoiceProject[];
  archivedProjects: VoiceProject[];
  activeProject: VoiceProject | null;
  runtime: CodexRuntimeState;
  codexSettings: CodexSettings;
  realtime: {
    available: boolean;
    model: string;
    modelSource: "environment" | "saved" | "default";
    voice: string;
    reasoningEffort: string | null;
    reason: string | null;
    apiKeySource: "environment" | "saved" | null;
    apiKeyEncrypted: boolean;
  };
};

export type CodexActionResult = {
  kind: "turn" | "command";
  message: string;
  turnId: string | null;
  project: VoiceProject | null;
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
  reasoningEffort?: string | null;
};

export type CodexVoiceApi = {
  getState(): Promise<AppState>;
  openDebugWindow(): Promise<void>;
  getEvents(): Promise<AppEvent[]>;
  clearEvents(): Promise<void>;
  logEvent(event: AppEvent): Promise<void>;
  createProject(name?: string): Promise<VoiceProject>;
  resumeProject(projectId: string): Promise<VoiceProject>;
  archiveProject(projectId: string): Promise<VoiceProject>;
  restoreProject(projectId: string): Promise<VoiceProject>;
  createChat(name: string, projectId?: string): Promise<VoiceProject>;
  switchChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  archiveChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  restoreChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  listChats(projectId?: string): Promise<VoiceChat[]>;
  showProjectChats(open?: boolean): Promise<void>;
  summarizeProject(projectId?: string, chatId?: string): Promise<string>;
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
  setRealtimeModel(model: RealtimeModel): Promise<AppState>;
  createRealtimeClientSecret(): Promise<RealtimeClientSecret>;
  onAppState(listener: (state: AppState) => void): () => void;
  onAppEvent(listener: (event: AppEvent) => void): () => void;
};
