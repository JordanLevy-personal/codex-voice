import { EventEmitter } from "node:events";
import type {
  AppEvent,
  CodexApprovalPolicy,
  AppState,
  ApprovalDecision,
  CodexActionResult,
  CodexChatRuntime,
  CodexModelSummary,
  CodexPermissionMode,
  VoiceChat,
  CodexSettings,
  CodexSettingsScope,
  CodexSandboxMode,
  CodexThreadTokenUsage,
  CodexRuntimeState,
  PendingRequestDetail,
  PendingRequestQuestion,
  PendingRequestQuestionOption,
  PendingCodexRequest,
  ReasoningEffort,
  ToolQuestionAnswer,
  VoiceSession,
} from "../shared/types";
import {
  CODEX_PERMISSION_PROFILES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
} from "../shared/types";
import { CodexBridge, type CodexJsonMessage } from "./codexBridge";
import { createRealtimeClientSecret, realtimeConfig } from "./realtime";
import { SessionStore } from "./sessionStore";

type TurnWaiter = {
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ChatContext = {
  session: VoiceSession;
  chat: VoiceChat;
  recovered?: boolean;
};

type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export class VoiceCodexOrchestrator extends EventEmitter {
  private activeSessionId: string | null = null;
  private showSessionChatsFlag = false;
  private nextTurnModel: string | null = null;
  private nextTurnReasoningEffort: ReasoningEffort | null = null;
  private nextTurnPermissionMode: CodexPermissionMode | null = null;
  private defaultModel: string | null = DEFAULT_CODEX_MODEL;
  private defaultReasoningEffort: ReasoningEffort | null = DEFAULT_CODEX_REASONING_EFFORT;
  private defaultPermissionMode: CodexPermissionMode = DEFAULT_CODEX_PERMISSION_MODE;
  private models: CodexModelSummary[] = [];
  private status = "Starting Codex app-server.";
  private pendingRequests = new Map<string, PendingCodexRequest>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private activeTurnByThread = new Map<string, string>();
  private activeTurnModelByThread = new Map<string, string | null>();
  private activeTurnReasoningEffortByThread = new Map<string, ReasoningEffort | null>();
  private activeTurnPermissionModeByThread = new Map<string, CodexPermissionMode | null>();
  private threadByTurn = new Map<string, string>();
  private tokenUsageByThread = new Map<string, CodexThreadTokenUsage>();
  private threadStatusByThread = new Map<string, string>();

  constructor(
    private readonly store: SessionStore,
    private readonly codex: CodexBridge,
  ) {
    super();
    this.codex.on("notification", (message) => this.handleNotification(message as CodexJsonMessage));
    this.codex.on("serverRequest", (message) => this.handleServerRequest(message as CodexJsonMessage));
    this.codex.on("stderr", (text) => this.emitEvent("codex", "stderr", text));
    this.codex.on("exit", (info) => {
      this.status = "Codex app-server exited.";
      this.emitEvent("codex", "exit", `Codex app-server exited: ${JSON.stringify(info)}`, info);
      this.emitState();
    });
  }

  async initialize(): Promise<void> {
    await this.store.ensureReady();
    await this.codex.start();
    await this.refreshModels();
    this.status = "Ready.";
    this.emitEvent("app", "ready", "Codex app-server is ready.");
    this.emitState();
  }

  shutdown(): void {
    this.codex.stop();
  }

  async state(): Promise<AppState> {
    const sessions = await this.store.listSessions();
    const archivedSessions = await this.store.listArchivedSessions();
    let activeSession = this.activeSessionId
      ? sessions.find((session) => session.id === this.activeSessionId) ?? null
      : null;
    if (this.activeSessionId && !activeSession) {
      this.activeSessionId = null;
      this.showSessionChatsFlag = false;
      activeSession = null;
    }
    return {
      baseFolder: this.store.baseFolder,
      sessions,
      archivedSessions,
      activeSession,
      runtime: this.runtimeState(activeSession, sessions),
      codexSettings: this.codexSettings(activeSession),
      realtime: realtimeConfig(),
    };
  }

  async createSession(name?: string): Promise<VoiceSession> {
    const session = await this.store.createSession(name);
    const chatSettings = this.initialChatSettings(session);
    const result = (await this.codex.request("thread/start", {
      cwd: session.folderPath,
      ...(chatSettings.model ? { model: chatSettings.model } : {}),
      ...permissionParams(chatSettings.permissionMode),
      personality: "friendly",
      serviceName: "codex_voice",
    })) as { thread?: { id?: string } };

    const codexThreadId = result.thread?.id;
    if (!codexThreadId) {
      throw new Error("Codex did not return a thread id.");
    }

    const updated = await this.store.addChat(session.id, "Main task", codexThreadId, chatSettings);
    this.activeSessionId = updated.id;
    this.showSessionChatsFlag = false;
    this.status = `Active session: ${updated.displayName}`;
    this.emitEvent("app", "sessionCreated", `Created session "${updated.displayName}".`, updated);
    this.emitState();
    return updated;
  }

  async resumeSession(sessionId: string): Promise<VoiceSession> {
    let session = await this.store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    let chat = activeChatForSession(session);
    if (!chat?.codexThreadId) {
      const updated = await this.startChatThread(session, "Main task");
      this.activeSessionId = updated.id;
      this.showSessionChatsFlag = false;
      this.status = `Created a new chat for session: ${updated.displayName}`;
      this.emitEvent("app", "sessionResumed", this.status, updated);
      this.emitState();
      return updated;
    }

    const resumed = await this.resumeChatThread(session, chat);

    const updated = await this.store.updateSession(resumed.session.id, {
      activeChatId: resumed.chat.id,
      codexThreadId: resumed.chat.codexThreadId,
      lastStatus: resumed.recovered ? "Started a fresh Codex thread." : "Codex thread resumed.",
    });
    this.activeSessionId = updated.id;
    this.showSessionChatsFlag = false;
    this.status = resumed.recovered
      ? `Recovered session chat: ${resumed.chat.displayName}`
      : `Resumed session: ${updated.displayName}`;
    this.emitEvent("app", "sessionResumed", `Resumed session "${updated.displayName}".`, updated);
    this.emitState();
    return updated;
  }

  async archiveSession(sessionId: string): Promise<VoiceSession> {
    const updated = await this.store.archiveSession(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
      this.showSessionChatsFlag = false;
    }
    this.status = `Archived session: ${updated.displayName}`;
    this.emitEvent("app", "sessionArchived", this.status, updated);
    this.emitState();
    return updated;
  }

  async restoreSession(sessionId: string): Promise<VoiceSession> {
    const updated = await this.store.restoreSession(sessionId);
    this.status = `Restored session: ${updated.displayName}`;
    this.emitEvent("app", "sessionRestored", this.status, updated);
    this.emitState();
    return updated;
  }

  async createChat(name: string, sessionId?: string): Promise<VoiceSession> {
    const displayName = name.trim();
    if (!displayName) throw new Error("Chat name is required.");
    const session = await this.requireSession(sessionId);
    const updated = await this.startChatThread(session, displayName);
    this.activeSessionId = updated.id;
    this.showSessionChatsFlag = true;
    this.status = `Active chat: ${displayName}`;
    this.emitEvent("app", "chatCreated", `Created chat "${displayName}".`, activeChatForSession(updated));
    this.emitState();
    return updated;
  }

  async switchChat(chatId: string, sessionId?: string): Promise<VoiceSession> {
    const session = sessionId ? await this.requireSession(sessionId) : await this.requireSessionForChat(chatId);
    const chat = session.chats.find((candidate) => candidate.id === chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    if (!chat.codexThreadId) throw new Error(`Chat "${chat.displayName}" does not have a Codex thread id.`);

    const resumed = await this.resumeChatThread(session, chat);

    const updated = await this.store.setActiveChat(resumed.session.id, resumed.chat.id);
    this.activeSessionId = updated.id;
    this.showSessionChatsFlag = true;
    this.status = resumed.recovered
      ? `Recovered and switched to chat: ${resumed.chat.displayName}`
      : `Active chat: ${resumed.chat.displayName}`;
    this.emitEvent("app", "chatSwitched", `Switched to chat "${resumed.chat.displayName}".`, resumed.chat);
    this.emitState();
    return updated;
  }

  async archiveChat(chatId: string, sessionId?: string): Promise<VoiceSession> {
    const session = sessionId ? await this.requireSession(sessionId) : await this.requireSessionForChat(chatId);
    const chat = session.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    const visibleChats = session.chats.filter((candidate) => !candidate.archivedAt);
    const sessionWithReplacement =
      visibleChats.length === 1 && visibleChats[0]?.id === chat.id
        ? await this.startChatThread(session, "Main task")
        : session;
    const updated = await this.store.archiveChat(sessionWithReplacement.id, chat.id);
    if (this.activeSessionId === session.id) {
      this.activeSessionId = updated.id;
      this.showSessionChatsFlag = Boolean(updated.activeChatId);
    }
    this.status = `Archived chat: ${chat.displayName}`;
    this.emitEvent("app", "chatArchived", this.status, { sessionId: session.id, chatId: chat.id });
    this.emitState();
    return updated;
  }

  async restoreChat(chatId: string, sessionId?: string): Promise<VoiceSession> {
    const session = sessionId
      ? await this.store.getSession(sessionId, { includeArchived: true })
      : await this.findSessionForChat(chatId, true);
    if (!session) throw new Error(`Unknown chat: ${chatId}`);
    const chat = session.chats.find((candidate) => candidate.id === chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    const updated = await this.store.restoreChat(session.id, chat.id);
    this.status = `Restored chat: ${chat.displayName}`;
    this.emitEvent("app", "chatRestored", this.status, { sessionId: session.id, chatId: chat.id });
    this.emitState();
    return updated;
  }

  async listChats(sessionId?: string): Promise<VoiceChat[]> {
    const session = await this.requireSession(sessionId);
    return session.chats.filter((chat) => !chat.archivedAt);
  }

  async showSessionChats(open = true): Promise<void> {
    this.showSessionChatsFlag = open;
    this.status = open ? "Showing open chats." : "Hiding open chats.";
    this.emitEvent("app", "showSessionChats", this.status, { open });
    this.emitState();
  }

  async sendToCodex(text: string, chatId?: string): Promise<CodexActionResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Cannot send an empty request to Codex.");

    if (trimmed.startsWith("/")) {
      return this.handleNativeSlashCommand(trimmed);
    }

    let context: ChatContext;
    if (!this.activeSessionId && !chatId) {
      const session = await this.createSession(titleFromText(trimmed));
      context = this.requireActiveChatContextFromSession(session);
    } else {
      context = await this.requireChatContext(chatId);
    }
    const { session, chat } = await this.resumeChatThread(context.session, context.chat);
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");

    const turnSettings = this.resolveTurnSettings(session, chat);
    const result = (await this.codex.request("turn/start", {
      threadId: chat.codexThreadId,
      cwd: session.folderPath,
      ...permissionParams(turnSettings.permissionMode),
      personality: "friendly",
      ...(turnSettings.model ? { model: turnSettings.model } : {}),
      ...(turnSettings.reasoningEffort ? { effort: turnSettings.reasoningEffort } : {}),
      input: [
        {
          type: "text",
          text: codexTurnText(trimmed),
          text_elements: [],
        },
      ],
    })) as { turn?: { id?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id.");

    this.activeTurnByThread.set(chat.codexThreadId, turnId);
    this.threadByTurn.set(turnId, chat.codexThreadId);
    this.activeTurnModelByThread.set(chat.codexThreadId, turnSettings.model);
    this.activeTurnReasoningEffortByThread.set(chat.codexThreadId, turnSettings.reasoningEffort);
    this.activeTurnPermissionModeByThread.set(chat.codexThreadId, turnSettings.permissionMode);
    this.nextTurnModel = null;
    this.nextTurnReasoningEffort = null;
    this.nextTurnPermissionMode = null;
    this.status = `${chat.displayName}: Codex is working.`;
    const updated = await this.store.updateChat(session.id, chat.id, {
      lastStatus: "Codex is working.",
    });
    this.emitEvent("app", "turnStarted", `Sent request to "${chat.displayName}".`, { turnId, chatId: chat.id, text: trimmed });
    this.emitState();
    return {
      kind: "turn",
      message: `Codex started with ${this.describeModelEffort(turnSettings.model, turnSettings.reasoningEffort)}.`,
      turnId,
      session: updated,
      chat: updated.chats.find((candidate) => candidate.id === chat.id) ?? null,
    };
  }

  async steerCodex(text: string, chatId?: string): Promise<{ turnId: string }> {
    const { session, chat } = await this.requireChatContext(chatId);
    const threadId = chat.codexThreadId;
    const turnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
    if (!threadId || !turnId) {
      throw new Error("There is no active Codex turn to steer.");
    }
    await this.codex.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [
        {
          type: "text",
          text: text.trim(),
          text_elements: [],
        },
      ],
    });
    await this.store.updateChat(session.id, chat.id, { lastStatus: "Steered active turn." });
    this.status = `Steered "${chat.displayName}".`;
    this.emitEvent("app", "turnSteered", `Steered "${chat.displayName}".`, { text, chatId: chat.id });
    this.emitState();
    return { turnId };
  }

  async interruptCodex(chatId?: string): Promise<void> {
    const { session, chat } = await this.requireChatContext(chatId);
    const threadId = chat.codexThreadId;
    const turnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
    if (!threadId || !turnId) {
      throw new Error("There is no active Codex turn to interrupt.");
    }
    await this.codex.request("turn/interrupt", {
      threadId,
      turnId,
    });
    await this.store.updateChat(session.id, chat.id, { lastStatus: "Requested Codex interruption." });
    this.status = `Requested interruption for "${chat.displayName}".`;
    this.emitEvent("app", "turnInterrupted", this.status, { chatId: chat.id, turnId });
    this.emitState();
  }

  async summarizeSession(sessionId?: string, chatId?: string): Promise<string> {
    const target =
      (sessionId ? await this.store.getSession(sessionId) : null) ??
      (this.activeSessionId ? await this.store.getSession(this.activeSessionId) : null) ??
      (await this.store.getMostRecent());
    if (!target) throw new Error("No recent sessions are available to summarize.");

    const chat = chatId
      ? target.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt) ?? null
      : activeChatForSession(target) ?? target.chats.find((candidate) => !candidate.archivedAt) ?? null;
    if (chatId && !chat) throw new Error(`Unknown chat for session "${target.displayName}": ${chatId}`);
    if (!chat?.codexThreadId) throw new Error("Session is missing a Codex chat thread id.");
    const resumed = await this.resumeChatThread(target, chat);
    const resumedThreadId = resumed.chat.codexThreadId;
    if (!resumedThreadId) throw new Error("Session is missing a Codex chat thread id.");

    const turnSettings = this.resolveTurnSettings(resumed.session, resumed.chat);
    const result = (await this.codex.request("turn/start", {
      threadId: resumedThreadId,
      cwd: resumed.session.folderPath,
      ...permissionParams(turnSettings.permissionMode),
      personality: "friendly",
      ...(turnSettings.model ? { model: turnSettings.model } : {}),
      ...(turnSettings.reasoningEffort ? { effort: turnSettings.reasoningEffort } : {}),
      input: [
        {
          type: "text",
          text:
            "Please summarize this Codex voice session for the user in 4-6 concise bullets. Focus on what the user was trying to do, what Codex changed or found, current status, and useful next steps. Do not invent context.",
          text_elements: [],
        },
      ],
    })) as { turn?: { id?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error("Codex did not return a summary turn id.");
    this.activeTurnByThread.set(resumedThreadId, turnId);
    this.threadByTurn.set(turnId, resumedThreadId);
    this.activeTurnModelByThread.set(resumedThreadId, turnSettings.model);
    this.activeTurnReasoningEffortByThread.set(resumedThreadId, turnSettings.reasoningEffort);
    this.activeTurnPermissionModeByThread.set(resumedThreadId, turnSettings.permissionMode);
    this.nextTurnModel = null;
    this.nextTurnReasoningEffort = null;
    this.nextTurnPermissionMode = null;
    this.status = `Codex is summarizing "${resumed.chat.displayName}".`;
    this.emitEvent("app", "summaryStarted", `Summarizing "${resumed.chat.displayName}".`, {
      turnId,
      chatId: resumed.chat.id,
    });
    this.emitState();

    const summary = await this.waitForTurnText(turnId);
    await this.store.updateChat(resumed.session.id, resumed.chat.id, {
      lastSummary: summary,
      lastStatus: "Chat summarized.",
    });
    this.emitEvent("app", "summaryCompleted", "Codex summarized the session.", { summary });
    this.emitState();
    return summary;
  }

  async answerApproval(requestId: string | number, decision: ApprovalDecision): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) throw new Error(`Unknown pending request: ${requestId}`);

    const response = await this.responseForDecision(request, decision);
    if (response.kind === "error") {
      this.codex.rejectRequest(requestId, response.message);
    } else {
      this.codex.respond(requestId, response.result);
    }
    this.pendingRequests.delete(String(requestId));
    this.status = `Answered ${request.title}: ${decision}`;
    if (request.threadId) {
      this.updateChatForThread(request.threadId, { lastStatus: `Answered ${request.title}: ${decision}` });
    }
    this.emitEvent("app", "approvalAnswered", `Answered ${request.title}: ${decision}`, {
      requestId,
      decision,
    });
    this.emitState();
  }

  private async responseForDecision(
    request: PendingCodexRequest,
    decision: ApprovalDecision,
  ): Promise<ServerRequestResponse> {
    if (request.method === "item/tool/call") {
      return this.responseForDynamicToolCall(request, decision);
    }
    if (request.method === "account/chatgptAuthTokens/refresh" && isAcceptDecision(decision)) {
      return this.responseForChatgptAuthRefresh(request);
    }
    return responseForDecision(request, decision);
  }

  private async responseForDynamicToolCall(
    request: PendingCodexRequest,
    decision: ApprovalDecision,
  ): Promise<ServerRequestResponse> {
    if (!isAcceptDecision(decision)) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `User ${decision === "cancel" ? "cancelled" : "declined"} the requested tool call.`,
            },
          ],
        },
      };
    }

    const params = request.raw as {
      params?: {
        threadId?: unknown;
        namespace?: unknown;
        tool?: unknown;
        arguments?: unknown;
      };
    };
    const threadId = stringField(params.params?.threadId);
    const server = stringField(params.params?.namespace);
    const tool = stringField(params.params?.tool);

    if (!threadId || !server || !tool) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "The app-server tool call did not include enough MCP routing information to run it.",
            },
          ],
        },
      };
    }

    try {
      const result = await this.codex.request("mcpServer/tool/call", {
        threadId,
        server,
        tool,
        ...(params.params?.arguments !== undefined ? { arguments: params.params.arguments } : {}),
      });
      return dynamicToolResponseFromMcpResult(result);
    } catch (error) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        },
      };
    }
  }

  private async responseForChatgptAuthRefresh(request: PendingCodexRequest): Promise<ServerRequestResponse> {
    const params = request.raw as { params?: { previousAccountId?: unknown } };
    const previousAccountId = stringField(params.params?.previousAccountId);

    try {
      const authStatus = (await this.codex.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      })) as { authToken?: string | null };
      const accountResponse = (await this.codex.request("account/read", {
        refreshToken: true,
      })) as { account?: { type?: string; planType?: string | null } | null };
      const token = stringField(authStatus.authToken);
      if (!token || !previousAccountId) {
        return responseForDecision(request, "decline");
      }
      return {
        kind: "result",
        result: {
          accessToken: token,
          chatgptAccountId: previousAccountId,
          chatgptPlanType:
            accountResponse.account?.type === "chatgpt" ? accountResponse.account.planType ?? null : null,
        },
      };
    } catch {
      return responseForDecision(request, "decline");
    }
  }

  async answerToolQuestion(requestId: string | number, answers: ToolQuestionAnswer[]): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) throw new Error(`Unknown pending request: ${requestId}`);
    if (request.method !== "item/tool/requestUserInput") {
      throw new Error(`Pending request ${requestId} is not a Codex question.`);
    }
    const normalizedAnswers = normalizeToolQuestionAnswers(request, answers);
    const result = {
      answers: Object.fromEntries(
        normalizedAnswers.map((answer) => [answer.questionId, { answers: answer.answers }]),
      ),
    };
    this.codex.respond(requestId, result);
    this.pendingRequests.delete(String(requestId));
    this.status = "Answered Codex question.";
    if (request.threadId) {
      this.updateChatForThread(request.threadId, { lastStatus: "Answered Codex question." });
    }
    this.emitEvent("app", "questionAnswered", "Answered a Codex question.", {
      requestId,
      answers: normalizedAnswers,
    });
    this.emitState();
  }

  async getChatStatus(chatId?: string): Promise<CodexChatRuntime[]> {
    const session = chatId ? await this.requireSessionForChat(chatId) : await this.requireSession();
    const runtimes = this.chatRuntimeStates(session);
    return chatId ? runtimes.filter((runtime) => runtime.chatId === chatId) : runtimes;
  }

  async setCodexSettings(
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null; permissionMode?: CodexPermissionMode | null },
    scope: CodexSettingsScope,
  ): Promise<CodexSettings> {
    if (settings.model !== undefined && settings.model !== null) {
      this.assertKnownModel(settings.model);
    }
    if (settings.reasoningEffort !== undefined && settings.reasoningEffort !== null) {
      this.assertReasoningEffort(settings.reasoningEffort);
    }
    if (settings.permissionMode !== undefined && settings.permissionMode !== null) {
      this.assertPermissionMode(settings.permissionMode);
    }

    if (scope === "nextTurn") {
      if (settings.model !== undefined) this.nextTurnModel = settings.model;
      if (settings.reasoningEffort !== undefined) {
        this.nextTurnReasoningEffort = settings.reasoningEffort;
      }
      if (settings.permissionMode !== undefined) this.nextTurnPermissionMode = settings.permissionMode;
      this.status = `Updated next-turn Codex settings: ${this.describeModelEffort(
        this.nextTurnModel,
        this.nextTurnReasoningEffort,
      )}, ${this.describePermissions(this.nextTurnPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE)}.`;
      this.emitEvent("app", "settingsChanged", this.status);
      this.emitState();
      return this.codexSettings(await this.getActiveSession());
    }

    const { session, chat } = await this.requireChatContext();
    const updated = await this.store.updateChat(session.id, chat.id, {
      ...(settings.model !== undefined ? { model: settings.model } : {}),
      ...(settings.reasoningEffort !== undefined
        ? { reasoningEffort: settings.reasoningEffort }
        : {}),
      ...(settings.permissionMode !== undefined
        ? { permissionMode: settings.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE }
        : {}),
      lastStatus: "Updated Codex settings.",
    });
    const updatedChat = updated.chats.find((candidate) => candidate.id === chat.id) ?? chat;
    this.status = `Updated chat Codex settings: ${this.describeModelEffort(
      updatedChat.model,
      updatedChat.reasoningEffort,
    )}, ${this.describePermissions(updatedChat.permissionMode)}.`;
    this.emitEvent("app", "settingsChanged", this.status, updated);
    this.emitState();
    return this.codexSettings(updated);
  }

  createRealtimeClientSecret = createRealtimeClientSecret;

  private async getActiveSession(): Promise<VoiceSession | null> {
    return this.activeSessionId ? this.store.getSession(this.activeSessionId) : null;
  }

  private async requireSession(sessionId?: string): Promise<VoiceSession> {
    const id = sessionId ?? this.activeSessionId;
    if (!id) throw new Error("No active Codex session.");
    const session = await this.store.getSession(id);
    if (!session) throw new Error(`Unknown voice session: ${id}`);
    return session;
  }

  private async requireSessionForChat(chatId: string): Promise<VoiceSession> {
    const session = await this.findSessionForChat(chatId, false);
    if (!session) throw new Error(`Unknown chat: ${chatId}`);
    return session;
  }

  private async findSessionForChat(chatId: string, includeArchived: boolean): Promise<VoiceSession | null> {
    const sessions = await this.store.listSessions({ includeArchived });
    return (
      sessions.find((candidate) =>
        candidate.chats.some((chat) => chat.id === chatId && (includeArchived || !chat.archivedAt)),
      ) ?? null
    );
  }

  private async requireActiveSession(): Promise<VoiceSession> {
    return this.requireSession();
  }

  private async requireChatContext(chatId?: string): Promise<ChatContext> {
    if (chatId) {
      const session = await this.requireSessionForChat(chatId);
      const chat = session.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt);
      if (!chat) throw new Error(`Unknown chat: ${chatId}`);
      return { session, chat };
    }

    let session = await this.requireSession();
    let chat = activeChatForSession(session);
    if (!chat) {
      session = await this.createChat("Main task", session.id);
      chat = activeChatForSession(session);
    }
    if (!chat) throw new Error("Active session does not have an active chat.");
    return { session, chat };
  }

  private requireActiveChatContextFromSession(session: VoiceSession): ChatContext {
    const chat = activeChatForSession(session);
    if (!chat) throw new Error("Session does not have an active chat.");
    return { session, chat };
  }

  private async resumeChatThread(session: VoiceSession, chat: VoiceChat): Promise<ChatContext> {
    if (!chat.codexThreadId) {
      throw new Error(`Chat "${chat.displayName}" does not have a Codex thread id.`);
    }
    const chatSettings = this.threadSettingsForChat(session, chat);

    try {
      await this.codex.request("thread/resume", {
        threadId: chat.codexThreadId,
        cwd: session.folderPath,
        ...permissionParams(chatSettings.permissionMode),
        personality: "friendly",
        excludeTurns: true,
        ...(chatSettings.model ? { model: chatSettings.model } : {}),
      });
      return { session, chat };
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
    }

    const result = (await this.codex.request("thread/start", {
      cwd: session.folderPath,
      ...(chatSettings.model ? { model: chatSettings.model } : {}),
      ...permissionParams(chatSettings.permissionMode),
      personality: "friendly",
      serviceName: "codex_voice",
    })) as { thread?: { id?: string } };

    const codexThreadId = result.thread?.id;
    if (!codexThreadId) throw new Error("Codex did not return a replacement thread id.");

    const updatedSession = await this.store.updateChat(session.id, chat.id, {
      codexThreadId,
      lastStatus: "Started a fresh Codex thread.",
    });
    const updatedChat = updatedSession.chats.find((candidate) => candidate.id === chat.id);
    if (!updatedChat) throw new Error(`Unknown chat after recovery: ${chat.id}`);

    this.emitEvent(
      "app",
      "chatThreadRecovered",
      `Started a fresh Codex thread for "${updatedChat.displayName}" because the previous rollout was unavailable.`,
      { chatId: updatedChat.id, oldThreadId: chat.codexThreadId, newThreadId: codexThreadId },
    );
    return { session: updatedSession, chat: updatedChat, recovered: true };
  }

  private async startChatThread(session: VoiceSession, displayName: string): Promise<VoiceSession> {
    const chatSettings = this.initialChatSettings(session);
    const result = (await this.codex.request("thread/start", {
      cwd: session.folderPath,
      ...(chatSettings.model ? { model: chatSettings.model } : {}),
      ...permissionParams(chatSettings.permissionMode),
      personality: "friendly",
      serviceName: "codex_voice",
    })) as { thread?: { id?: string } };

    const codexThreadId = result.thread?.id;
    if (!codexThreadId) throw new Error("Codex did not return a thread id.");

    return this.store.addChat(session.id, displayName, codexThreadId, chatSettings);
  }

  private handleServerRequest(message: CodexJsonMessage): void {
    if (message.id === undefined || !message.method) return;
    const pending = describeServerRequest(message);
    this.pendingRequests.set(String(message.id), pending);
    this.status = pending.title;
    this.emitEvent("codex", "serverRequest", pending.title, pending);
    if (pending.threadId) {
      this.updateChatForThread(pending.threadId, { lastStatus: pending.title });
    }
    this.emitState();
  }

  private handleNotification(message: CodexJsonMessage): void {
    const method = message.method ?? "notification";
    const params = message.params as Record<string, unknown> | undefined;
    const threadId = stringField(params?.threadId);
    const status = statusFromNotification(method, params);
    if (status) {
      this.status = status;
      this.emitEvent("codex", method, status, message.params);
      if (threadId) this.updateChatForThread(threadId, { lastStatus: status });
    } else if (method !== "item/agentMessage/delta") {
      this.emitEvent("codex", method, method, message.params);
    }

    if (method === "turn/started") {
      const turn = (params?.turn ?? {}) as { id?: string };
      if (threadId && turn.id) {
        this.activeTurnByThread.set(threadId, turn.id);
        this.threadByTurn.set(turn.id, threadId);
      }
    }

    if (method === "thread/status/changed") {
      const statusParams = params as { threadId?: string; status?: unknown };
      if (statusParams.threadId) {
        this.threadStatusByThread.set(statusParams.threadId, describeThreadStatus(statusParams.status));
      }
    }

    if (method === "serverRequest/resolved") {
      const resolvedParams = params as { requestId?: string | number; threadId?: string };
      if (resolvedParams.requestId !== undefined) {
        const resolved = this.pendingRequests.get(String(resolvedParams.requestId));
        this.pendingRequests.delete(String(resolvedParams.requestId));
        if (resolved?.threadId) {
          this.updateChatForThread(resolved.threadId, { lastStatus: "Codex request resolved." });
        }
      }
    }

    if (method === "thread/tokenUsage/updated") {
      const usageParams = params as { threadId?: string; tokenUsage?: CodexThreadTokenUsage };
      if (usageParams.threadId && usageParams.tokenUsage) {
        this.tokenUsageByThread.set(usageParams.threadId, usageParams.tokenUsage);
      }
    }

    if (method === "item/agentMessage/delta") {
      const deltaParams = params as { turnId?: string; delta?: string };
      if (deltaParams.turnId && deltaParams.delta) {
        const waiter = this.turnWaiters.get(deltaParams.turnId);
        if (waiter) waiter.text += deltaParams.delta;
      }
    }

    if (method === "turn/completed") {
      const turn = (params?.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } };
      const completedThreadId = threadId ?? (turn.id ? this.threadByTurn.get(turn.id) : undefined);
      if (completedThreadId) {
        const activeTurnId = this.activeTurnByThread.get(completedThreadId);
        const completedCurrentTurn = !turn.id || activeTurnId === turn.id;
        if (completedCurrentTurn) {
          this.activeTurnByThread.delete(completedThreadId);
          this.activeTurnModelByThread.delete(completedThreadId);
          this.activeTurnReasoningEffortByThread.delete(completedThreadId);
          this.updateChatForThread(completedThreadId, {
            lastStatus: turn.status === "failed" ? "Codex turn failed." : "Codex finished.",
          });
        }
      }
      if (turn.id) {
        this.threadByTurn.delete(turn.id);
        const waiter = this.turnWaiters.get(turn.id);
        if (waiter) {
          clearTimeout(waiter.timeout);
          this.turnWaiters.delete(turn.id);
          if (turn.status === "failed") {
            waiter.reject(new Error(turn.error?.message ?? "Codex summary turn failed."));
          } else {
            waiter.resolve(waiter.text.trim() || "Codex finished, but no summary text was returned.");
          }
        }
      }
    }

    this.emitState();
  }

  private waitForTurnText(turnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error("Timed out waiting for Codex summary text."));
      }, 180_000);
      this.turnWaiters.set(turnId, { text: "", resolve, reject, timeout });
    });
  }

  private runtimeState(activeSession: VoiceSession | null, sessions: VoiceSession[]): CodexRuntimeState {
    const activeChat = activeSession ? activeChatForSession(activeSession) : null;
    const activeThreadId = activeChat?.codexThreadId ?? null;
    const chatRuntimes = activeSession ? this.chatRuntimeStates(activeSession) : [];
    const activeRuntime = activeChat
      ? chatRuntimes.find((runtime) => runtime.chatId === activeChat.id) ?? null
      : null;
    return {
      ready: this.codex.ready,
      activeSessionId: this.activeSessionId,
      activeChatId: activeChat?.id ?? null,
      activeTurnId: activeRuntime?.activeTurnId ?? null,
      status: activeRuntime?.status ?? this.status,
      threadStatus: activeThreadId ? this.threadStatusByThread.get(activeThreadId) ?? null : null,
      tokenUsage: activeThreadId ? this.tokenUsageByThread.get(activeThreadId) ?? null : null,
      pendingRequests: this.runtimePendingRequests(activeSession, chatRuntimes, sessions),
      chats: chatRuntimes,
      showSessionChats: this.showSessionChatsFlag,
    };
  }

  private chatRuntimeStates(session: VoiceSession): CodexChatRuntime[] {
    return session.chats.filter((chat) => !chat.archivedAt).map((chat) => {
      const threadId = chat.codexThreadId;
      const pendingRequests = threadId
        ? [...this.pendingRequests.values()]
            .filter((request) => request.threadId === threadId)
            .map((request) => ({
              ...request,
              sessionId: session.id,
              sessionName: session.displayName,
              chatId: chat.id,
              chatName: chat.displayName,
            }))
        : [];
      const activeTurnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
      return {
        chatId: chat.id,
        threadId,
        displayName: chat.displayName,
        activeTurnId,
        status: pendingRequests[0]?.title ?? (activeTurnId ? "Codex is working." : chat.lastStatus ?? "Idle"),
        threadStatus: threadId ? this.threadStatusByThread.get(threadId) ?? null : null,
        tokenUsage: threadId ? this.tokenUsageByThread.get(threadId) ?? null : null,
        pendingRequests,
        activeTurnModel: threadId ? this.activeTurnModelByThread.get(threadId) ?? null : null,
        activeTurnReasoningEffort: threadId
          ? this.activeTurnReasoningEffortByThread.get(threadId) ?? null
          : null,
      };
    });
  }

  private runtimePendingRequests(
    activeSession: VoiceSession | null,
    chatRuntimes: CodexChatRuntime[],
    sessions: VoiceSession[],
  ): PendingCodexRequest[] {
    const chatByThread = new Map(
      chatRuntimes
        .filter((runtime): runtime is CodexChatRuntime & { threadId: string } => Boolean(runtime.threadId))
        .map((runtime) => [runtime.threadId, runtime]),
    );
    const storedChatByThread = new Map<string, { session: VoiceSession; chat: VoiceChat }>();
    for (const session of sessions) {
      for (const chat of session.chats) {
        if (chat.codexThreadId && !chat.archivedAt) {
          storedChatByThread.set(chat.codexThreadId, { session, chat });
        }
      }
    }
    return [...this.pendingRequests.values()].map((request) => {
      if (!request.threadId) return request;
      const runtime = chatByThread.get(request.threadId);
      const stored = storedChatByThread.get(request.threadId);
      if (!runtime && !stored) return request;
      return {
        ...request,
        sessionId: stored?.session.id ?? activeSession?.id,
        chatId: runtime?.chatId ?? stored?.chat.id,
        sessionName: stored?.session.displayName,
        chatName: runtime?.displayName ?? stored?.chat.displayName,
      };
    });
  }

  private async refreshModels(): Promise<void> {
    try {
      const result = (await this.codex.request("model/list", {
        limit: 100,
        includeHidden: false,
      })) as { data?: CodexModelSummary[] };
      this.models = (result.data ?? []).map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        hidden: model.hidden,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
      }));
      this.defaultModel = DEFAULT_CODEX_MODEL;
      this.defaultReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
    } catch (error) {
      this.emitEvent(
        "app",
        "modelListFailed",
        error instanceof Error ? error.message : "Unable to list Codex models.",
      );
    }
  }

  private codexSettings(activeSession: VoiceSession | null): CodexSettings {
    const activeChat = activeSession ? activeChatForSession(activeSession) : null;
    const activeThreadId = activeChat?.codexThreadId ?? null;
    const chatModel = activeChat?.model ?? activeSession?.model ?? null;
    const chatReasoningEffort = activeChat?.reasoningEffort ?? activeSession?.reasoningEffort ?? null;
    const chatPermissionMode = activeChat?.permissionMode ?? activeSession?.permissionMode ?? this.defaultPermissionMode;
    return {
      chatModel,
      chatReasoningEffort,
      chatPermissionMode,
      sessionModel: chatModel,
      sessionReasoningEffort: chatReasoningEffort,
      sessionPermissionMode: chatPermissionMode,
      nextTurnModel: this.nextTurnModel,
      nextTurnReasoningEffort: this.nextTurnReasoningEffort,
      nextTurnPermissionMode: this.nextTurnPermissionMode,
      activeTurnModel: activeThreadId ? this.activeTurnModelByThread.get(activeThreadId) ?? null : null,
      activeTurnReasoningEffort: activeThreadId
        ? this.activeTurnReasoningEffortByThread.get(activeThreadId) ?? null
        : null,
      activeTurnPermissionMode: activeThreadId
        ? this.activeTurnPermissionModeByThread.get(activeThreadId) ?? null
        : null,
      defaultModel: this.defaultModel,
      defaultReasoningEffort: this.defaultReasoningEffort,
      defaultPermissionMode: this.defaultPermissionMode,
      models: this.models,
    };
  }

  private resolveTurnSettings(session: VoiceSession, chat?: VoiceChat | null): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    permissionMode: CodexPermissionMode;
  } {
    const settings = this.threadSettingsForChat(session, chat ?? activeChatForSession(session));
    return {
      model: this.nextTurnModel ?? settings.model,
      reasoningEffort:
        this.nextTurnReasoningEffort ??
        settings.reasoningEffort,
      permissionMode: this.nextTurnPermissionMode ?? settings.permissionMode,
    };
  }

  private initialChatSettings(session: VoiceSession): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    permissionMode: CodexPermissionMode;
  } {
    return {
      model: session.model ?? this.defaultModel ?? DEFAULT_CODEX_MODEL,
      reasoningEffort:
        session.reasoningEffort ?? this.defaultReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      permissionMode: session.permissionMode ?? this.defaultPermissionMode,
    };
  }

  private threadSettingsForChat(
    session: VoiceSession,
    chat?: VoiceChat | null,
  ): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    permissionMode: CodexPermissionMode;
  } {
    return {
      model: chat?.model ?? session.model ?? this.defaultModel ?? DEFAULT_CODEX_MODEL,
      reasoningEffort:
        chat?.reasoningEffort ??
        session.reasoningEffort ??
        this.defaultReasoningEffort ??
        DEFAULT_CODEX_REASONING_EFFORT,
      permissionMode: chat?.permissionMode ?? session.permissionMode ?? this.defaultPermissionMode,
    };
  }

  private async handleNativeSlashCommand(text: string): Promise<CodexActionResult> {
    const { command, args, rest } = parseSlashInput(text);
    const lowerCommand = command.toLowerCase();

    if (!lowerCommand || lowerCommand === "help") {
      return this.commandResult(nativeSlashHelpText());
    }

    if (lowerCommand === "status" || lowerCommand === "settings") {
      return this.commandResult(await this.nativeStatusText(), await this.getActiveSession());
    }

    if (lowerCommand === "model" || lowerCommand === "models") {
      return this.handleModelSlash(args);
    }

    if (lowerCommand === "permissions" || lowerCommand === "approvals") {
      return this.handlePermissionsSlash(args);
    }

    if (lowerCommand === "effort" || lowerCommand === "reasoning") {
      return this.commandResult(
        "Reasoning effort is part of Codex's native /model command. Use /model <effort> or /model <model> <effort>.",
      );
    }

    if (lowerCommand === "review") {
      return this.handleReviewSlash(args);
    }

    if (lowerCommand === "compact") {
      return this.handleCompactSlash();
    }

    if (lowerCommand === "mcp") {
      return this.handleMcpSlash(args);
    }

    if (lowerCommand === "apps") {
      return this.handleAppsSlash();
    }

    if (lowerCommand === "plugins") {
      return this.handlePluginsSlash();
    }

    if (lowerCommand === "new") {
      const session = await this.createSession(rest || undefined);
      return this.commandResult(`Created new Codex voice session: ${session.displayName}\n${session.folderPath}`, session);
    }

    if (lowerCommand === "resume") {
      const targetId = args[0] ?? (await this.store.getMostRecent())?.id;
      if (!targetId) throw new Error("No recent Codex voice sessions exist yet.");
      const session = await this.resumeSession(targetId);
      return this.commandResult(`Resumed Codex voice session: ${session.displayName}`, session);
    }

    const unsupported = nativeUnsupportedSlashCommand(lowerCommand);
    if (unsupported) {
      return this.commandResult(unsupported);
    }

    return this.commandResult(`Unknown Codex slash command: /${command}. Try /help.`);
  }

  private async handleModelSlash(args: string[]): Promise<CodexActionResult> {
    await this.refreshModels();
    const activeSession = await this.getActiveSession();

    if (args.length === 0) {
      return this.commandResult(
        [this.currentSettingsText(activeSession), "", "Available models", formatModelList(this.models)].join("\n"),
        activeSession,
      );
    }

    const parsed = parseModelSlashArgs(args, activeSession ? "chat" : "nextTurn");
    if (parsed.model !== undefined && parsed.model !== null) this.assertKnownModel(parsed.model);
    if (parsed.reasoningEffort !== undefined && parsed.reasoningEffort !== null) {
      this.assertReasoningEffort(parsed.reasoningEffort);
    }

    const settings = await this.setCodexSettings(
      {
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.reasoningEffort !== undefined ? { reasoningEffort: parsed.reasoningEffort } : {}),
      },
      parsed.scope,
    );
    return this.commandResult(`Updated /model for ${parsed.scope}.\n${settingsText(settings)}`, await this.getActiveSession());
  }

  private async handlePermissionsSlash(args: string[]): Promise<CodexActionResult> {
    const activeSession = await this.getActiveSession();
    if (args.length === 0) {
      return this.commandResult(
        [
          this.currentSettingsText(activeSession),
          "",
          "Permission modes",
          ...CODEX_PERMISSION_PROFILES.map(
            (profile) =>
              `${profile.mode} - ${profile.displayName}: approval ${profile.approvalPolicy}, sandbox ${profile.sandbox}`,
          ),
        ].join("\n"),
        activeSession,
      );
    }

    const mode = permissionModeFromText(args.join(" "));
    const settings = await this.setCodexSettings({ permissionMode: mode }, activeSession ? "chat" : "nextTurn");
    return this.commandResult(
      `Updated /permissions to ${permissionProfile(mode).displayName}.\n${settingsText(settings)}`,
      await this.getActiveSession(),
    );
  }

  private async handleReviewSlash(args: string[]): Promise<CodexActionResult> {
    const { session, chat } = await this.requireChatContext();
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");
    const { target, delivery } = parseReviewSlashArgs(args);
    const turnSettings = this.resolveTurnSettings(session, chat);
    const result = (await this.codex.request("review/start", {
      threadId: chat.codexThreadId,
      target,
      ...(delivery ? { delivery } : {}),
    })) as { turn?: { id?: string }; reviewThreadId?: string };

    const turnId = result.turn?.id ?? null;
    if (turnId) {
      this.activeTurnByThread.set(chat.codexThreadId, turnId);
      this.threadByTurn.set(turnId, chat.codexThreadId);
      this.activeTurnModelByThread.set(chat.codexThreadId, turnSettings.model);
      this.activeTurnReasoningEffortByThread.set(chat.codexThreadId, turnSettings.reasoningEffort);
      this.activeTurnPermissionModeByThread.set(chat.codexThreadId, turnSettings.permissionMode);
    }
    const updated = await this.store.updateChat(session.id, chat.id, {
      lastStatus: "Codex review started.",
    });
    this.status = "Codex review started.";
    return this.commandResult(
      `Started /review (${describeReviewTarget(target)}) in ${chat.displayName}. Review thread: ${result.reviewThreadId ?? chat.codexThreadId}.`,
      updated,
    );
  }

  private async handleCompactSlash(): Promise<CodexActionResult> {
    const { session, chat } = await this.requireChatContext();
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");
    await this.codex.request("thread/compact/start", { threadId: chat.codexThreadId });
    const updated = await this.store.updateChat(session.id, chat.id, {
      lastStatus: "Context compaction requested.",
    });
    return this.commandResult(`Requested native /compact for "${chat.displayName}".`, updated);
  }

  private async handleMcpSlash(args: string[]): Promise<CodexActionResult> {
    const verbose = args.some((arg) => arg.toLowerCase() === "verbose" || arg.toLowerCase() === "full");
    const result = (await this.codex.request("mcpServerStatus/list", {
      limit: 100,
      detail: verbose ? "full" : "toolsAndAuthOnly",
    })) as { data?: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }> };
    return this.commandResult(formatMcpServers(result.data ?? [], verbose), await this.getActiveSession());
  }

  private async handleAppsSlash(): Promise<CodexActionResult> {
    const session = await this.getActiveSession();
    const chat = session ? activeChatForSession(session) : null;
    const result = (await this.codex.request("app/list", {
      limit: 100,
      threadId: chat?.codexThreadId ?? null,
      forceRefetch: false,
    })) as { data?: Array<{ id: string; name: string; isEnabled: boolean; isAccessible: boolean; pluginDisplayNames?: string[] }> };
    return this.commandResult(formatApps(result.data ?? []), session);
  }

  private async handlePluginsSlash(): Promise<CodexActionResult> {
    const session = await this.getActiveSession();
    const result = (await this.codex.request("plugin/list", {
      cwds: session?.folderPath ? [session.folderPath] : null,
    })) as {
      marketplaces?: Array<{
        name: string;
        plugins?: Array<{ id: string; name: string; installed: boolean; enabled: boolean }>;
      }>;
      marketplaceLoadErrors?: unknown[];
    };
    return this.commandResult(formatPlugins(result.marketplaces ?? [], result.marketplaceLoadErrors ?? []), session);
  }

  private async nativeStatusText(): Promise<string> {
    const session = await this.getActiveSession();
    const chat = session ? activeChatForSession(session) : null;
    const threadId = chat?.codexThreadId ?? null;
    const settings = this.codexSettings(session);
    const resolved = session
      ? this.resolveTurnSettings(session, chat)
      : {
          model: settings.nextTurnModel ?? settings.defaultModel,
          reasoningEffort: settings.nextTurnReasoningEffort ?? settings.defaultReasoningEffort,
          permissionMode: settings.nextTurnPermissionMode ?? settings.defaultPermissionMode,
        };
    const tokenUsage = threadId ? this.tokenUsageByThread.get(threadId) ?? null : null;
    const [configSummary, rateLimitSummary] = await Promise.all([
      this.readConfigSummary(session),
      this.readRateLimitSummary(),
    ]);

    return [
      "Codex /status",
      `Chat: ${chat?.displayName ?? "none"}`,
      `Thread: ${threadId ?? "none"}`,
      `Folder: ${session?.folderPath ?? "none"}`,
      `Runtime: ${this.threadStatusByThread.get(threadId ?? "") ?? this.status}`,
      `Active turn: ${threadId ? this.activeTurnByThread.get(threadId) ?? "none" : "none"}`,
      `Effective next turn: model ${resolved.model ?? "default"}, reasoning ${resolved.reasoningEffort ?? "default"}, permissions ${permissionProfile(resolved.permissionMode).displayName}`,
      `Chat override: model ${settings.chatModel ?? "default"}, reasoning ${settings.chatReasoningEffort ?? "default"}, permissions ${permissionProfile(settings.chatPermissionMode).displayName}`,
      `Active turn model: ${settings.activeTurnModel ?? "none"}, reasoning ${settings.activeTurnReasoningEffort ?? "none"}, permissions ${settings.activeTurnPermissionMode ? permissionProfile(settings.activeTurnPermissionMode).displayName : "none"}`,
      `Voice app defaults: ${permissionProfile(settings.defaultPermissionMode).displayName}.`,
      `Context: ${formatTokenUsage(tokenUsage)}`,
      `Rate limits: ${rateLimitSummary}`,
      configSummary,
    ].join("\n");
  }

  private async readConfigSummary(session: VoiceSession | null): Promise<string> {
    try {
      const result = (await this.codex.request("config/read", {
        includeLayers: false,
        cwd: session?.folderPath ?? null,
      })) as { config?: Record<string, unknown> };
      const config = result.config ?? {};
      return `Config defaults: model ${formatConfigValue(config.model)}, reasoning ${formatConfigValue(
        config.model_reasoning_effort,
      )}, approval ${formatConfigValue(config.approval_policy)}, sandbox ${formatConfigValue(config.sandbox_mode)}.`;
    } catch (error) {
      return `Config defaults: unavailable (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  private async readRateLimitSummary(): Promise<string> {
    try {
      const result = (await this.codex.request("account/rateLimits/read", undefined)) as {
        rateLimits?: unknown;
        rateLimitsByLimitId?: Record<string, unknown> | null;
      };
      const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
      return formatRateLimit(bucket);
    } catch (error) {
      return `unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  private commandResult(message: string, session: VoiceSession | null = null): CodexActionResult {
    this.status = message.split("\n")[0] || "Native slash command handled.";
    this.emitEvent("app", "slashCommand", message);
    this.emitState();
    return { kind: "command", message, turnId: null, session, chat: session ? activeChatForSession(session) : null };
  }

  private currentSettingsText(activeSession: VoiceSession | null): string {
    return settingsText(this.codexSettings(activeSession));
  }

  private assertKnownModel(model: string): void {
    if (model === DEFAULT_CODEX_MODEL) return;
    if (this.models.length === 0) return;
    const found = this.models.some((candidate) => candidate.model === model || candidate.id === model);
    if (!found) {
      throw new Error(`Unknown model "${model}". Use /model to list available models.`);
    }
  }

  private assertReasoningEffort(effort: string): asserts effort is ReasoningEffort {
    const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
    if (!allowed.includes(effort as ReasoningEffort)) {
      throw new Error(`Unknown reasoning effort "${effort}". Use one of: ${allowed.join(", ")}.`);
    }
  }

  private assertPermissionMode(mode: string): asserts mode is CodexPermissionMode {
    const allowed = CODEX_PERMISSION_PROFILES.map((profile) => profile.mode);
    if (!allowed.includes(mode as CodexPermissionMode)) {
      throw new Error(`Unknown permission mode "${mode}". Use one of: ${allowed.join(", ")}.`);
    }
  }

  private describeModelEffort(model: string | null, effort: ReasoningEffort | null): string {
    return `model ${model ?? this.defaultModel ?? "default"}, reasoning ${
      effort ?? this.defaultReasoningEffort ?? "default"
    }`;
  }

  private describePermissions(mode: CodexPermissionMode): string {
    const profile = permissionProfile(mode);
    return `permissions ${profile.displayName}`;
  }

  private updateChatForThread(threadId: string, patch: Partial<VoiceChat>): void {
    void this.findChatByThread(threadId)
      .then((context) => {
        if (!context) return null;
        return this.store.updateChat(context.session.id, context.chat.id, patch);
      })
      .then(() => this.emitState())
      .catch((error) => {
        this.emitEvent(
          "app",
          "chatUpdateFailed",
          error instanceof Error ? error.message : "Unable to update chat status.",
        );
      });
  }

  private async findChatByThread(threadId: string): Promise<ChatContext | null> {
    const sessions = await this.store.listSessions();
    for (const session of sessions) {
      const chat = session.chats.find((candidate) => candidate.codexThreadId === threadId && !candidate.archivedAt);
      if (chat) return { session, chat };
    }
    return null;
  }

  private emitState(): void {
    void this.state().then((state) => this.emit("state", state));
  }

  private emitEvent(source: AppEvent["source"], kind: string, message: string, raw?: unknown): void {
    this.emit("event", {
      at: new Date().toISOString(),
      source,
      kind,
      message,
      raw,
    } satisfies AppEvent);
  }
}

function describeServerRequest(message: CodexJsonMessage): PendingCodexRequest {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const method = message.method ?? "serverRequest";
  const requestId = message.id ?? "";

  if (method === "item/commandExecution/requestApproval") {
    const command = stringField(params.command);
    const details = detailList([
      detail("Command", command),
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Approval callback", stringField(params.approvalId)),
      detail("Network context", describeNetworkApprovalContext(params.networkApprovalContext)),
      detail("Parsed actions", describeCommandActions(params.commandActions)),
      detail("Proposed command rule", describeExecpolicyAmendment(params.proposedExecpolicyAmendment)),
      detail("Proposed network rule", describeNetworkPolicyAmendments(params.proposedNetworkPolicyAmendments)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "Command approval needed",
      subtitle: command ? "Shell command" : "Command execution",
      body: requestBody(stringField(params.reason), command ? `Command: ${command}` : null, "Codex wants to run a command."),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const fileChanges =
      method === "applyPatchApproval" ? describeFileChanges(params.fileChanges) : undefined;
    const details = detailList([
      detail("Reason", stringField(params.reason)),
      detail("Requested write root", stringField(params.grantRoot)),
      detail("Files", fileChanges),
      detail("Call", stringField(params.callId)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId) || stringField(params.conversationId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "File change approval needed",
      subtitle: stringField(params.grantRoot) ? "Extra write access" : "File edit",
      body: requestBody(
        stringField(params.reason),
        fileChanges ? `Files: ${fileChanges}` : null,
        "Codex wants to apply file changes.",
      ),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/tool/requestUserInput") {
    const questions = normalizeQuestions(params.questions);
    const questionBody = questions
      .map((question) => describeQuestionForBody(question))
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "question",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: questions.length === 1 ? questions[0].header || "Codex has a question" : "Codex has questions",
      subtitle: "Waiting on user input",
      body: questionBody || "Codex is waiting for user input.",
      details: detailList([detail("Questions", String(questions.length || 1))]),
      questions,
      raw: message,
    };
  }

  if (method === "mcpServer/elicitation/request") {
    const mode = stringField(params.mode);
    const details = detailList([
      detail("Server", stringField(params.serverName)),
      detail("Mode", mode),
      detail("URL", stringField(params.url)),
      detail("Elicitation", stringField(params.elicitationId)),
      detail("Schema", mode === "form" ? describeJsonValue(params.requestedSchema) : undefined),
    ]);
    return {
      kind: "elicitation",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      title: "MCP input needed",
      subtitle: stringField(params.serverName) ?? undefined,
      body: requestBody(stringField(params.message), stringField(params.url), "An MCP server is asking for input."),
      details,
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const details = detailList([
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Permissions", describePermissionProfile(params.permissions)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "Permission approval needed",
      subtitle: "Additional permissions",
      body: stringField(params.reason) || "Codex is requesting additional permissions.",
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/tool/call") {
    const details = detailList([
      detail("Namespace", stringField(params.namespace)),
      detail("Tool", stringField(params.tool)),
      detail("Arguments", describeJsonValue(params.arguments)),
    ]);
    return {
      kind: "tool",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.callId),
      title: "Tool call approval needed",
      subtitle: stringField(params.tool),
      body: stringField(params.tool)
        ? `Codex wants to use ${[stringField(params.namespace), stringField(params.tool)].filter(Boolean).join(".")}.`
        : "Codex wants to use a dynamic app-server tool.",
      details,
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      kind: "auth",
      requestId,
      method,
      title: "ChatGPT auth refresh needed",
      subtitle: "Account token refresh",
      body:
        "Codex app-server asked this client to refresh ChatGPT auth tokens. Codex Voice cannot refresh ChatGPT desktop auth tokens directly.",
      details: detailList([
        detail("Reason", stringField(params.reason)),
        detail("Previous account", stringField(params.previousAccountId)),
      ]),
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : "";
    const details = detailList([
      detail("Command", command),
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Approval callback", stringField(params.approvalId)),
      detail("Call", stringField(params.callId)),
      detail("Parsed command", describeJsonValue(params.parsedCmd)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.conversationId),
      title: "Command approval needed",
      subtitle: "Legacy command approval",
      body: requestBody(stringField(params.reason), command ? `Command: ${command}` : null, "Codex wants to run a command."),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  return {
    kind: "unknown",
    requestId,
    method,
    title: "Codex needs a response",
    subtitle: "Unsupported app-server request",
    body: method,
    details: detailList([detail("Params", describeJsonValue(params))]),
    options: ["cancel"],
    raw: message,
  };
}

function detail(label: string, value: string | undefined | null): PendingRequestDetail | null {
  if (!value?.trim()) return null;
  return { label, value: value.trim() };
}

function detailList(items: Array<PendingRequestDetail | null>): PendingRequestDetail[] {
  return items.filter((item): item is PendingRequestDetail => item !== null);
}

function requestBody(...parts: Array<string | null | undefined>): string {
  const fallback = parts.at(-1);
  const body = parts
    .slice(0, -1)
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
  return body || fallback || "Codex is waiting for a user response.";
}

function normalizeQuestions(value: unknown): PendingRequestQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((question, index): PendingRequestQuestion | null => {
      if (!question || typeof question !== "object") return null;
      const record = question as Record<string, unknown>;
      const options = Array.isArray(record.options)
        ? record.options
            .map((option): PendingRequestQuestionOption | null => {
              if (!option || typeof option !== "object") return null;
              const optionRecord = option as Record<string, unknown>;
              const label = stringField(optionRecord.label);
              if (!label) return null;
              return {
                label,
                description: stringField(optionRecord.description) ?? "",
              };
            })
            .filter((option): option is PendingRequestQuestionOption => option !== null)
        : null;
      return {
        id: stringField(record.id) ?? `question-${index + 1}`,
        header: stringField(record.header) ?? `Question ${index + 1}`,
        question: stringField(record.question) ?? "Codex is asking for input.",
        isOther: Boolean(record.isOther),
        isSecret: Boolean(record.isSecret),
        options,
      };
    })
    .filter((question): question is PendingRequestQuestion => question !== null);
}

function describeQuestionForBody(question: PendingRequestQuestion): string {
  const options = question.options?.length
    ? `Options: ${question.options.map((option) => option.label).join(", ")}`
    : null;
  return [question.header, question.question, options].filter(Boolean).join("\n");
}

function describeCommandActions(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .map((action) => {
      if (!action || typeof action !== "object") return null;
      const record = action as Record<string, unknown>;
      const type = stringField(record.type) ?? "unknown";
      if (type === "read") {
        return `Read ${stringField(record.name) ?? "file"} at ${stringField(record.path) ?? "unknown path"}`;
      }
      if (type === "listFiles") {
        return `List files${stringField(record.path) ? ` in ${stringField(record.path)}` : ""}`;
      }
      if (type === "search") {
        return `Search${stringField(record.query) ? ` for ${stringField(record.query)}` : ""}${
          stringField(record.path) ? ` in ${stringField(record.path)}` : ""
        }`;
      }
      return stringField(record.command) ?? type;
    })
    .filter(Boolean)
    .join("; ");
}

function describeNetworkApprovalContext(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const host = stringField(record.host);
  const protocol = stringField(record.protocol);
  if (!host && !protocol) return undefined;
  return [protocol, host].filter(Boolean).join(" ");
}

function describeExecpolicyAmendment(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => String(entry)).join(" ");
}

function describeNetworkPolicyAmendments(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .map((amendment) => {
      if (!amendment || typeof amendment !== "object") return null;
      const record = amendment as Record<string, unknown>;
      const action = stringField(record.action) ?? "allow";
      const host = stringField(record.host) ?? "unknown host";
      return `${action} ${host}`;
    })
    .filter(Boolean)
    .join("; ");
}

function describePermissionProfile(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const network = record.network as Record<string, unknown> | null | undefined;
  if (network && typeof network === "object") {
    parts.push(`network ${network.enabled === false ? "disabled" : "enabled"}`);
  }
  const fileSystem = record.fileSystem as Record<string, unknown> | null | undefined;
  if (fileSystem && typeof fileSystem === "object") {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read.map(String).join(", ") : "";
    const write = Array.isArray(fileSystem.write) ? fileSystem.write.map(String).join(", ") : "";
    const entries = Array.isArray(fileSystem.entries) ? `${fileSystem.entries.length} entries` : "";
    if (read) parts.push(`read: ${read}`);
    if (write) parts.push(`write: ${write}`);
    if (entries) parts.push(entries);
  }
  return parts.join("; ") || describeJsonValue(value);
}

function describeFileChanges(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const names = Object.keys(value as Record<string, unknown>);
  if (names.length === 0) return undefined;
  return names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
}

function describeJsonValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ServerRequestResponse =
  | { kind: "result"; result: unknown }
  | { kind: "error"; message: string };

function isAcceptDecision(decision: ApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

function responseForDecision(request: PendingCodexRequest, decision: ApprovalDecision): ServerRequestResponse {
  const method = request.method;
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const legacy = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: "denied",
      cancel: "abort",
    } as const;
    return { kind: "result", result: { decision: legacy[decision] } };
  }
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { kind: "result", result: { decision } };
  }
  if (method === "mcpServer/elicitation/request") {
    const action = decision === "cancel" ? "cancel" : decision === "decline" ? "decline" : "accept";
    return { kind: "result", result: { action, content: null, _meta: null } };
  }
  if (method === "item/permissions/requestApproval") {
    if (decision === "decline" || decision === "cancel") {
      return { kind: "error", message: `Permission request ${decision === "cancel" ? "cancelled" : "declined"}.` };
    }
    return {
      kind: "result",
      result: {
        permissions: permissionGrantFromRequest(request),
        scope: decision === "acceptForSession" ? "session" : "turn",
      },
    };
  }
  if (method === "item/tool/call") {
    return {
      kind: "result",
      result: {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Codex Voice cannot service dynamic app-server tool calls yet.",
          },
        ],
      },
    };
  }
  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      kind: "error",
      message:
        "Codex Voice cannot refresh ChatGPT auth tokens directly. Re-authenticate Codex from the desktop app or CLI, then retry.",
    };
  }
  return { kind: "error", message: `Unsupported Codex server request method: ${method}` };
}

function dynamicToolResponseFromMcpResult(result: unknown): ServerRequestResponse {
  const response = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const contentItems = Array.isArray(response.content)
    ? response.content.map(dynamicContentItemFromMcpContent)
    : [];
  if (response.structuredContent !== undefined && response.structuredContent !== null) {
    contentItems.push({
      type: "inputText",
      text: describeJsonValue(response.structuredContent) ?? String(response.structuredContent),
    });
  }
  if (contentItems.length === 0) {
    contentItems.push({
      type: "inputText",
      text: response.isError ? "MCP tool returned an error with no content." : "MCP tool completed with no content.",
    });
  }
  return {
    kind: "result",
    result: {
      success: response.isError !== true,
      contentItems,
    },
  };
}

function dynamicContentItemFromMcpContent(content: unknown): { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string } {
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "inputText", text: record.text };
    }
    if (record.type === "image") {
      const imageUrl = stringField(record.imageUrl);
      if (imageUrl) return { type: "inputImage", imageUrl };
      const data = stringField(record.data);
      const mimeType = stringField(record.mimeType) ?? "image/png";
      if (data) return { type: "inputImage", imageUrl: `data:${mimeType};base64,${data}` };
    }
  }
  return {
    type: "inputText",
    text: describeJsonValue(content) ?? String(content),
  };
}

function normalizeToolQuestionAnswers(
  request: PendingCodexRequest,
  answers: ToolQuestionAnswer[],
): ToolQuestionAnswer[] {
  const byQuestionId = new Map(
    answers.map((answer) => [
      answer.questionId,
      answer.answers.map((value) => value.trim()).filter(Boolean),
    ]),
  );
  const expectedQuestions = request.questions ?? [];
  if (expectedQuestions.length === 0) {
    const normalized = answers
      .map((answer) => ({
        questionId: answer.questionId,
        answers: answer.answers.map((value) => value.trim()).filter(Boolean),
      }))
      .filter((answer) => answer.answers.length > 0);
    if (normalized.length === 0) {
      throw new Error("Answer is required before resolving Codex's question.");
    }
    return normalized;
  }

  return expectedQuestions.map((question) => {
    const values = byQuestionId.get(question.id) ?? [];
    if (values.length === 0) {
      throw new Error(`Answer is required for "${question.header || question.question}".`);
    }
    return { questionId: question.id, answers: values };
  });
}

function permissionGrantFromRequest(request: PendingCodexRequest): Record<string, unknown> {
  const raw = request.raw as { params?: { permissions?: { network?: unknown; fileSystem?: unknown } } };
  const permissions = raw.params?.permissions ?? {};
  return {
    ...(permissions.network ? { network: permissions.network } : {}),
    ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
  };
}

function statusFromNotification(method: string, params?: Record<string, unknown>): string | null {
  if (method === "turn/started") return "Codex started working.";
  if (method === "turn/completed") {
    const turn = (params?.turn ?? {}) as { status?: string };
    return turn.status === "failed" ? "Codex turn failed." : "Codex finished.";
  }
  if (method === "item/started") {
    const item = (params?.item ?? {}) as { type?: string; command?: string; server?: string; tool?: string; query?: string };
    if (item.type === "commandExecution") return `Codex is running: ${item.command ?? "a command"}`;
    if (item.type === "fileChange") return "Codex is preparing file changes.";
    if (item.type === "mcpToolCall") return `Codex is using ${item.server ?? "an app"} ${item.tool ?? "tool"}.`;
    if (item.type === "webSearch") return `Codex is searching: ${item.query ?? "the web"}`;
    if (item.type === "collabAgentToolCall") return "Codex is coordinating a sub-agent.";
    if (item.type === "agentMessage") return "Codex is writing a response.";
    return `Codex started ${item.type ?? "work"}.`;
  }
  if (method === "item/completed") {
    const item = (params?.item ?? {}) as { type?: string };
    if (item.type === "commandExecution") return "Codex finished a command.";
    if (item.type === "fileChange") return "Codex finished file changes.";
    if (item.type === "mcpToolCall") return "Codex finished using an app tool.";
  }
  if (method === "serverRequest/resolved") return "Codex request resolved.";
  if (method === "error") return "Codex reported an error.";
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function activeChatForSession(session: VoiceSession): VoiceChat | null {
  const chats = session.chats.filter((chat) => !chat.archivedAt);
  return (
    chats.find((chat) => chat.id === session.activeChatId) ??
    chats.find((chat) => chat.codexThreadId === session.codexThreadId) ??
    chats[0] ??
    null
  );
}

function titleFromText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 48) || "Voice Session";
}

function parseSlashInput(text: string): { command: string; args: string[]; rest: string } {
  const raw = text.slice(1).trim();
  const firstSpace = raw.search(/\s/);
  const command = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
  return { command, args: rest ? rest.split(/\s+/) : [], rest };
}

function nativeSlashHelpText(): string {
  return [
    "Native Codex slash commands exposed in this debug app:",
    "/status - show thread, model/reasoning, context, and rate-limit state.",
    "/model [chat|next] [model|effort] [effort] - headless model picker; session is accepted as a chat alias.",
    "/review [base <branch>|commit <sha>|custom <instructions>] [detached] - start app-server review.",
    "/compact - compact the active Codex thread context.",
    "/mcp [verbose] - list MCP servers reported by app-server.",
    "/apps - list apps/connectors reported by app-server.",
    "/plugins - list plugins reported by app-server.",
    "/permissions [default|auto-review|full-access] - show or update chat permission mode.",
    "/new [name] and /resume [sessionId] - voice-session equivalents of Codex conversation controls.",
    "Recognized but UI-only or not wired yet: /feedback, /plan-mode, /diff, /init, /agent, /mention, /stop, /fork, /side, /clear, /copy, /quit.",
  ].join("\n");
}

function nativeUnsupportedSlashCommand(command: string): string | null {
  const messages: Record<string, string> = {
    feedback:
      "Recognized native /feedback. This debug UI does not open the Codex feedback dialog or upload logs yet.",
    "plan-mode":
      "Recognized native /plan-mode. The v0 voice app intentionally keeps Realtime as a voice layer around normal Codex execution, so plan-mode is not wired here yet.",
    plan:
      "Recognized native /plan. The v0 voice app intentionally routes tasks to Codex execution rather than switching this debug surface into plan mode.",
    diff: "Recognized native /diff. This debug UI does not render Codex's diff view yet.",
    init: "Recognized native /init. Ask Codex to create or update AGENTS.md as a normal task for now.",
    "sandbox-add-read-dir":
      "Recognized native /sandbox-add-read-dir. Extra sandbox readable roots are not wired into this debug UI yet.",
    agent: "Recognized native /agent. Subagent thread switching is not exposed in this debug UI yet.",
    mention: "Recognized native /mention. File attachment UI is not wired yet; include the path in your request for now.",
    fast: "Recognized native /fast. Fast mode/service-tier switching is not wired into this debug UI yet.",
    personality: "Recognized native /personality. This voice app currently starts Codex with the friendly personality.",
    ps: "Recognized native /ps. Background terminal inventory is not exposed in this debug UI yet.",
    stop:
      "Recognized native /stop, which stops background terminals in Codex CLI. This debug app does not track those yet; use Interrupt to stop the active Codex turn.",
    fork: "Recognized native /fork. Forking Codex threads is not wired into the voice-session folder model yet.",
    side: "Recognized native /side. Side conversations are not wired into this debug UI yet.",
    clear: "Recognized native /clear. Use the Event Log Clear button for debug output; Codex thread history is unchanged.",
    copy: "Recognized native /copy. Copying the latest Codex output is not wired into this debug UI yet.",
    exit: "Recognized native /exit. This debug app does not close itself through slash commands.",
    quit: "Recognized native /quit. This debug app does not close itself through slash commands.",
    logout: "Recognized native /logout. Account logout is not exposed in this debug UI yet.",
    experimental: "Recognized native /experimental. Feature toggles are not exposed in this debug UI yet.",
    "debug-config": "Recognized native /debug-config. Config diagnostics are not rendered here yet; /status shows the effective basics.",
    statusline: "Recognized native /statusline. TUI status-line configuration does not apply to this debug UI.",
    title: "Recognized native /title. Terminal-title configuration does not apply to this debug UI.",
    keymap: "Recognized native /keymap. TUI keymap configuration does not apply to this debug UI.",
    interrupt: "Interrupt is a voice-app control rather than a native Codex slash command. Use the Interrupt button.",
    summarize: "Summarize is a voice-app action rather than a native Codex slash command. Use Summarize Active.",
  };
  return messages[command] ?? null;
}

function parseModelSlashArgs(
  args: string[],
  defaultScope: CodexSettingsScope,
): { scope: CodexSettingsScope; model?: string | null; reasoningEffort?: ReasoningEffort | null } {
  let scope = defaultScope;
  let tokens = [...args];
  if (isScopeToken(tokens[0])) {
    scope = scopeFromToken(tokens[0]);
    tokens = tokens.slice(1);
  }
  if (tokens.length > 1 && isScopeToken(tokens[tokens.length - 1])) {
    scope = scopeFromToken(tokens[tokens.length - 1]);
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) {
    throw new Error("Missing model or reasoning effort for /model.");
  }

  const first = tokens[0].toLowerCase();
  if (first === "effort" || first === "reasoning") {
    const effortToken = tokens[1];
    if (!effortToken) throw new Error("Missing reasoning effort for /model.");
    return { scope, reasoningEffort: parseNullableReasoningEffort(effortToken) };
  }

  if (isResetToken(first)) {
    return { scope, model: null, reasoningEffort: null };
  }

  if (isReasoningEffortToken(first)) {
    return { scope, reasoningEffort: first as ReasoningEffort };
  }

  return {
    scope,
    model: tokens[0],
    ...(tokens[1] ? { reasoningEffort: parseNullableReasoningEffort(tokens[1]) } : {}),
  };
}

function parseReviewSlashArgs(args: string[]): { target: ReviewTarget; delivery?: "inline" | "detached" } {
  const tokens = [...args];
  let delivery: "inline" | "detached" | undefined;
  const deliveryIndex = tokens.findIndex((token) => ["inline", "detached"].includes(token.toLowerCase()));
  if (deliveryIndex !== -1) {
    delivery = tokens[deliveryIndex].toLowerCase() as "inline" | "detached";
    tokens.splice(deliveryIndex, 1);
  }

  const mode = tokens[0]?.toLowerCase();
  if (!mode) return { target: { type: "uncommittedChanges" }, delivery };
  if (mode === "base" || mode === "branch") {
    const branch = tokens[1];
    if (!branch) throw new Error("Missing branch for /review base <branch>.");
    return { target: { type: "baseBranch", branch }, delivery };
  }
  if (mode === "commit") {
    const sha = tokens[1];
    if (!sha) throw new Error("Missing sha for /review commit <sha>.");
    const title = tokens.slice(2).join(" ").trim() || null;
    return { target: { type: "commit", sha, title }, delivery };
  }
  if (mode === "custom") {
    const instructions = tokens.slice(1).join(" ").trim();
    if (!instructions) throw new Error("Missing instructions for /review custom <instructions>.");
    return { target: { type: "custom", instructions }, delivery };
  }
  return { target: { type: "custom", instructions: tokens.join(" ") }, delivery };
}

function isScopeToken(value: string | undefined): value is string {
  return value === "chat" || value === "session" || value === "next" || value === "nextturn" || value === "next-turn";
}

function scopeFromToken(value: string): CodexSettingsScope {
  return value === "next" || value === "nextturn" || value === "next-turn" ? "nextTurn" : "chat";
}

function isResetToken(value: string): boolean {
  return value === "default" || value === "reset" || value === "clear";
}

function isReasoningEffortToken(value: string): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function parseNullableReasoningEffort(value: string): ReasoningEffort | null {
  const lower = value.toLowerCase();
  return isResetToken(lower) ? null : (lower as ReasoningEffort);
}

function formatModelList(models: CodexModelSummary[]): string {
  if (models.length === 0) return "No Codex models were returned by app-server.";
  return models
    .map((model) => {
      const efforts = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(", ");
      return `${model.model}${model.isDefault ? " (default)" : ""}: ${efforts || model.defaultReasoningEffort}`;
    })
    .join("\n");
}

function describeReviewTarget(target: ReviewTarget): string {
  if (target.type === "uncommittedChanges") return "uncommitted changes";
  if (target.type === "baseBranch") return `base branch ${target.branch}`;
  if (target.type === "commit") return `commit ${target.sha}`;
  return "custom instructions";
}

function describeThreadStatus(status: unknown): string {
  if (!status || typeof status !== "object") return "unknown";
  const value = status as { type?: string; activeFlags?: unknown[] };
  if (value.type === "active") return `active (${value.activeFlags?.length ?? 0} flags)`;
  return value.type ?? "unknown";
}

function formatTokenUsage(usage: CodexThreadTokenUsage | null): string {
  if (!usage) return "no token usage reported yet";
  const total = usage.total.totalTokens;
  if (!usage.modelContextWindow) return `${total.toLocaleString()} tokens used`;
  const percent = Math.round((total / usage.modelContextWindow) * 100);
  return `${total.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()} tokens (${percent}%), last turn ${usage.last.totalTokens.toLocaleString()}`;
}

function formatRateLimit(value: unknown): string {
  if (!value || typeof value !== "object") return "not reported";
  const snapshot = value as {
    limitName?: string | null;
    primary?: { usedPercent?: number; resetsAt?: number | null } | null;
    secondary?: { usedPercent?: number; resetsAt?: number | null } | null;
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
    planType?: string | null;
  };
  const primary = snapshot.primary
    ? `${Math.round(snapshot.primary.usedPercent ?? 0)}% used${formatResetTime(snapshot.primary.resetsAt)}`
    : "primary not reported";
  const secondary = snapshot.secondary
    ? `, secondary ${Math.round(snapshot.secondary.usedPercent ?? 0)}% used${formatResetTime(snapshot.secondary.resetsAt)}`
    : "";
  const credits = snapshot.credits
    ? `, credits ${snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "available" : "none")}`
    : "";
  return `${snapshot.limitName ?? "codex"} (${snapshot.planType ?? "unknown"}): ${primary}${secondary}${credits}`;
}

function formatResetTime(resetsAt: number | null | undefined): string {
  if (typeof resetsAt !== "number") return "";
  return `, resets ${new Date(resetsAt * 1000).toLocaleTimeString()}`;
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "default";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatMcpServers(
  servers: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }>,
  verbose: boolean,
): string {
  if (servers.length === 0) return "No MCP servers reported by app-server.";
  return [
    verbose ? "MCP servers (verbose)" : "MCP servers",
    ...servers.map((server) => {
      const toolNames = Object.keys(server.tools ?? {});
      const suffix = verbose && toolNames.length > 0 ? `: ${toolNames.slice(0, 12).join(", ")}` : "";
      return `${server.name} - ${server.authStatus ?? "auth unknown"} - ${toolNames.length} tools${suffix}`;
    }),
  ].join("\n");
}

function formatApps(
  apps: Array<{ id: string; name: string; isEnabled: boolean; isAccessible: boolean; pluginDisplayNames?: string[] }>,
): string {
  if (apps.length === 0) return "No apps/connectors reported by app-server.";
  return [
    "Apps/connectors",
    ...apps.map((app) => {
      const state = [app.isEnabled ? "enabled" : "disabled", app.isAccessible ? "accessible" : "not accessible"].join(", ");
      const plugins = app.pluginDisplayNames?.length ? ` via ${app.pluginDisplayNames.join(", ")}` : "";
      return `${app.name} (${app.id}) - ${state}${plugins}`;
    }),
  ].join("\n");
}

function formatPlugins(
  marketplaces: Array<{
    name: string;
    plugins?: Array<{ id: string; name: string; installed: boolean; enabled: boolean }>;
  }>,
  errors: unknown[],
): string {
  const pluginLines = marketplaces.flatMap((marketplace) =>
    (marketplace.plugins ?? []).map(
      (plugin) =>
        `${plugin.name} (${plugin.id}) - ${plugin.installed ? "installed" : "not installed"}, ${
          plugin.enabled ? "enabled" : "disabled"
        } - ${marketplace.name}`,
    ),
  );
  return [
    "Plugins",
    ...(pluginLines.length > 0 ? pluginLines : ["No plugins reported by app-server."]),
    ...(errors.length > 0 ? [`Marketplace load errors: ${errors.length}`] : []),
  ].join("\n");
}

function settingsText(settings: CodexSettings): string {
  const effectiveNextModel =
    settings.nextTurnModel ?? settings.chatModel ?? settings.defaultModel ?? "default";
  const effectiveNextEffort =
    settings.nextTurnReasoningEffort ??
    settings.chatReasoningEffort ??
    settings.defaultReasoningEffort ??
    "default";
  const effectiveNextPermissions =
    settings.nextTurnPermissionMode ?? settings.chatPermissionMode ?? settings.defaultPermissionMode;
  return [
    `Current chat default: model ${settings.chatModel ?? settings.defaultModel ?? "default"}, reasoning ${
      settings.chatReasoningEffort ?? settings.defaultReasoningEffort ?? "default"
    }, permissions ${permissionProfile(settings.chatPermissionMode).displayName}.`,
    `Next turn: model ${effectiveNextModel}, reasoning ${effectiveNextEffort}, permissions ${
      permissionProfile(effectiveNextPermissions).displayName
    }.`,
    `Active turn: model ${settings.activeTurnModel ?? "none"}, reasoning ${
      settings.activeTurnReasoningEffort ?? "none"
    }, permissions ${
      settings.activeTurnPermissionMode ? permissionProfile(settings.activeTurnPermissionMode).displayName : "none"
    }.`,
  ].join("\n");
}

function permissionProfile(mode: CodexPermissionMode) {
  return (
    CODEX_PERMISSION_PROFILES.find((profile) => profile.mode === mode) ??
    CODEX_PERMISSION_PROFILES[0]
  );
}

function permissionParams(mode: CodexPermissionMode): {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
} {
  const profile = permissionProfile(mode);
  return {
    approvalPolicy: profile.approvalPolicy,
    sandbox: profile.sandbox,
  };
}

function permissionModeFromText(text: string): CodexPermissionMode {
  const normalized = text.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["default", "default-permissions", "normal"].includes(normalized)) return "default";
  if (["auto", "auto-review", "autoreview"].includes(normalized)) return "auto-review";
  if (["full", "full-access", "danger", "danger-full-access"].includes(normalized)) return "full-access";
  throw new Error("Unknown permission mode. Use default, auto-review, or full-access.");
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message) || /unknown thread/i.test(message);
}

function codexTurnText(userText: string): string {
  return [
    "This request came through a local Realtime voice interface.",
    "Treat the current working directory as this voice session's workspace.",
    "Codex owns the actual planning, computer use, tool use, browser use, and execution.",
    "For requests that may require controlling desktop apps, the model should use tool_search to discover computer-use before choosing an approach; do this only once per new tool or plugin requested by the user.",
    "If the user's request mentions the Computer Use plugin, Codex must satisfy that request by discovering and using the actual computer-use plugin. Do not replace it with shell commands, open -a, AppleScript via terminal, or other terminal workarounds.",
    "Ask for clarification or approval when needed, and keep final status concise enough to relay by voice.",
    "",
    "User's spoken request:",
    userText,
  ].join("\n");
}
