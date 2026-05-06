import type { AppEvent, ApprovalDecision, AppState, PendingCodexRequest, ToolQuestionAnswer, VoiceChat } from "../../shared/types";

type RealtimeCallbacks = {
  onLog: (event: AppEvent) => void;
  onConnectionChange: (connected: boolean, label: string) => void;
};

type FunctionCallItem = {
  type: "function_call";
  name: string;
  call_id: string;
  arguments?: string;
};

export class RealtimeVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get connected(): boolean {
    return this.dc?.readyState === "open";
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    this.callbacks.onConnectionChange(false, "Creating Realtime session.");
    const secret = await window.codexVoice.createRealtimeClientSecret();

    const pc = new RTCPeerConnection();
    const audioEl = document.createElement("audio");
    this.pc = pc;
    this.audioEl = audioEl;
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream = stream;
      pc.addTrack(stream.getAudioTracks()[0], stream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("open", () => {
        this.callbacks.onConnectionChange(true, `Connected to ${secret.model} (${secret.voice}).`);
        this.log("connection", "Realtime data channel opened.");
      });
      dc.addEventListener("close", () => {
        this.callbacks.onConnectionChange(false, "Realtime data channel closed.");
        this.log("connection", "Realtime data channel closed.");
      });
      dc.addEventListener("message", (event) => this.handleMessage(event));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${secret.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Realtime WebRTC connection failed: ${response.status} ${text}`);
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.dc?.close();
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.audioEl = null;
    this.callbacks.onConnectionChange(false, "Realtime disconnected.");
  }

  speakStatus(message: string): void {
    if (!this.connected || !message.trim()) return;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        instructions: `Briefly tell the user this Codex status update in natural spoken English: ${JSON.stringify(
          message,
        )}`,
      },
    });
  }

  speakPendingRequest(request: PendingCodexRequest): void {
    if (!this.connected) return;
    const isQuestion = request.method === "item/tool/requestUserInput";
    const instructions = isQuestion
      ? [
          "Codex is asking the user a question.",
          "Briefly ask it in natural spoken English.",
          "Tell the user they can answer out loud.",
          `Question details: ${JSON.stringify(request.body || request.title)}`,
        ].join("\n")
      : [
          "Codex is waiting for user approval.",
          "Ask for permission in natural spoken English.",
          "Mention the concrete command, file change, or tool details if present.",
          "Tell the user they can say allow, allow for this session, decline, or cancel.",
          `Approval title: ${JSON.stringify(request.title)}`,
          `Approval details: ${JSON.stringify(request.body || request.method)}`,
        ].join("\n");
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions,
      },
    });
  }

  private handleMessage(event: MessageEvent<string>): void {
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.log("parseError", event.data);
      return;
    }

    if (payload.type === "response.output_audio_transcript.delta" && payload.delta) {
      this.log("voiceDelta", payload.delta, payload);
      return;
    }

    if (payload.type === "response.done") {
      const output = payload.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type === "function_call") {
            void this.handleFunctionCall(item as FunctionCallItem);
          }
        }
      }
    }

    if (payload.type === "error") {
      this.log("error", payload.error?.message ?? "Realtime error.", payload);
      return;
    }

    this.log(payload.type ?? "event", payload.type ?? "Realtime event.", payload);
  }

  private async handleFunctionCall(item: FunctionCallItem): Promise<void> {
    const args = safeJson(item.arguments);
    this.log("toolCall", `${item.name} ${JSON.stringify(args)}`, item);
    let output: unknown;

    try {
      output = await callVoiceTool(item.name, args);
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(output),
      },
    });
    this.send({ type: "response.create" });
  }

  private send(payload: unknown): void {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("Realtime data channel is not open.");
    }
    this.dc.send(JSON.stringify(payload));
  }

  private log(kind: string, message: string, raw?: unknown): void {
    this.callbacks.onLog({
      at: new Date().toISOString(),
      source: "realtime",
      kind,
      message,
      raw,
    });
  }
}

async function callVoiceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "submit_to_codex") {
    const request = stringArg(args.request);
    const context = optionalString(args.context);
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.chatName));
    const result = await window.codexVoice.sendToCodex(
      context ? `${request}\n\nVoice conversation context:\n${context}` : request,
      chatId,
    );
    return {
      ok: true,
      message: result.message,
      turnId: result.turnId,
      session: result.session,
      chat: result.chat,
    };
  }

  if (name === "steer_codex") {
    const result = await window.codexVoice.steerCodex(
      stringArg(args.message),
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)),
    );
    return { ok: true, message: "Codex received the update.", ...result };
  }

  if (name === "interrupt_codex") {
    await window.codexVoice.interruptCodex(await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)));
    return { ok: true, message: "Codex interruption was requested." };
  }

  if (name === "get_codex_status") {
    const state = await window.codexVoice.getState();
    return {
      ok: true,
      activeSession: state.activeSession,
      activeChat: state.activeSession ? activeChat(visibleChats(state.activeSession.chats), state.activeSession.activeChatId) : null,
      runtime: state.runtime,
      codexSettings: state.codexSettings,
    };
  }

  if (name === "answer_codex_approval") {
    const state = await window.codexVoice.getState();
    const request = findPendingRequest(
      state.runtime.pendingRequests,
      optionalString(args.requestId),
      (candidate) => candidate.method !== "item/tool/requestUserInput",
      "approval",
    );
    const decision = approvalDecisionArg(args.decision);
    await window.codexVoice.answerApproval(request.requestId, decision);
    return {
      ok: true,
      message: approvalDecisionMessage(decision),
      request: summarizePendingRequest(request),
    };
  }

  if (name === "answer_codex_question") {
    const answer = stringArg(args.answer);
    const state = await window.codexVoice.getState();
    const request = findPendingRequest(
      state.runtime.pendingRequests,
      optionalString(args.requestId),
      (candidate) => candidate.method === "item/tool/requestUserInput",
      "question",
    );
    const answers = answersForQuestionRequest(request, optionalString(args.questionId), answer);
    await window.codexVoice.answerToolQuestion(request.requestId, answers);
    return {
      ok: true,
      message: "Answered Codex's question.",
      request: summarizePendingRequest(request),
      answers,
    };
  }

  if (name === "set_codex_model") {
    const settings = await window.codexVoice.setCodexSettings(
      { model: stringArg(args.model) },
      scopeArg(args.scope),
    );
    return { ok: true, message: "Updated Codex model settings.", settings };
  }

  if (name === "set_codex_reasoning_effort") {
    const settings = await window.codexVoice.setCodexSettings(
      { reasoningEffort: reasoningEffortArg(args.reasoningEffort) },
      scopeArg(args.scope),
    );
    return { ok: true, message: "Updated Codex reasoning effort settings.", settings };
  }

  if (name === "create_new_codex_session") {
    const session = await window.codexVoice.createSession(optionalString(args.name));
    return { ok: true, session };
  }

  if (name === "create_new_codex_chat") {
    const session = await window.codexVoice.createChat(stringArg(args.name));
    return { ok: true, message: `Created chat ${stringArg(args.name)}.`, session, activeChat: activeChat(visibleChats(session.chats), session.activeChatId) };
  }

  if (name === "list_codex_chats") {
    const state = await window.codexVoice.getState();
    return {
      ok: true,
      activeChatId: state.runtime.activeChatId,
      chats: visibleChats(state.activeSession?.chats ?? []),
      statuses: state.runtime.chats,
    };
  }

  if (name === "switch_codex_chat") {
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.name));
    if (!chatId) throw new Error("No chat matched that request.");
    const session = await window.codexVoice.switchChat(chatId);
    return { ok: true, message: "Switched active chat.", session, activeChat: activeChat(visibleChats(session.chats), session.activeChatId) };
  }

  if (name === "get_codex_chat_status") {
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.name), true);
    const statuses = await window.codexVoice.getChatStatus(chatId);
    return { ok: true, statuses };
  }

  if (name === "show_open_codex_chats") {
    await window.codexVoice.showSessionChats(true);
    const state = await window.codexVoice.getState();
    return { ok: true, message: "Showing open chats.", chats: visibleChats(state.activeSession?.chats ?? []), statuses: state.runtime.chats };
  }

  if (name === "list_recent_codex_sessions") {
    const state = await window.codexVoice.getState();
    return {
      ok: true,
      sessions: state.sessions.slice(0, 8).map((session) => ({
        id: session.id,
        displayName: session.displayName,
        updatedAt: session.updatedAt,
        folderPath: session.folderPath,
        lastSummary: session.lastSummary,
        activeChatId: session.activeChatId,
        chats: visibleChats(session.chats),
      })),
    };
  }

  if (name === "continue_codex_session") {
    const state = await window.codexVoice.getState();
    const sessionId = optionalString(args.sessionId) || state.sessions[0]?.id;
    if (!sessionId) throw new Error("No recent Codex voice sessions exist yet.");
    const session = await window.codexVoice.resumeSession(sessionId);
    return { ok: true, session };
  }

  if (name === "summarize_recent_session") {
    const summary = await window.codexVoice.summarizeSession(optionalString(args.sessionId), await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), true));
    return { ok: true, summary };
  }

  throw new Error(`Unknown Realtime tool: ${name}`);
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tool argument must be a non-empty string.");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveChatId(
  chatId: string | undefined,
  name?: string,
  allowAll = false,
): Promise<string | undefined> {
  if (chatId) return chatId;
  if (!name) return allowAll ? undefined : undefined;
  const state = await window.codexVoice.getState();
  const chat = findChatByName(state, name);
  if (!chat) throw new Error(`No chat matched "${name}".`);
  return chat.id;
}

function findChatByName(state: AppState, name: string): VoiceChat | null {
  const needle = name.trim().toLowerCase();
  const chats = visibleChats(state.activeSession?.chats ?? []);
  const exact = chats.filter((chat) => chat.displayName.toLowerCase() === needle || chat.id === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`More than one chat matched "${name}".`);
  const partial = chats.filter((chat) => chat.displayName.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`More than one chat matched "${name}".`);
  return null;
}

function activeChat(chats: VoiceChat[], activeChatId: string | null): VoiceChat | null {
  const visible = visibleChats(chats);
  return visible.find((chat) => chat.id === activeChatId) ?? visible[0] ?? null;
}

function visibleChats(chats: VoiceChat[]): VoiceChat[] {
  return chats.filter((chat) => !chat.archivedAt);
}

function scopeArg(value: unknown): "session" | "nextTurn" {
  return value === "nextTurn" ? "nextTurn" : "session";
}

function reasoningEffortArg(value: unknown): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const effort = stringArg(value);
  const allowed = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
  if (!allowed.includes(effort as (typeof allowed)[number])) {
    throw new Error(`Unknown reasoning effort: ${effort}`);
  }
  return effort as (typeof allowed)[number];
}

function approvalDecisionArg(value: unknown): ApprovalDecision {
  const raw = stringArg(value).toLowerCase();
  if (["accept", "allow", "approve", "yes", "ok", "okay", "go ahead"].includes(raw)) {
    return "accept";
  }
  if (["acceptforsession", "accept_for_session", "allowforsession", "session", "always"].includes(raw)) {
    return "acceptForSession";
  }
  if (["decline", "deny", "no", "do not allow", "don't allow"].includes(raw)) {
    return "decline";
  }
  if (["cancel", "abort", "stop"].includes(raw)) {
    return "cancel";
  }
  throw new Error(`Unknown approval decision: ${raw}`);
}

function findPendingRequest(
  requests: PendingCodexRequest[],
  requestId: string | undefined,
  predicate: (request: PendingCodexRequest) => boolean,
  label: string,
): PendingCodexRequest {
  const matching = requests.filter(predicate);
  if (requestId) {
    const request = matching.find((candidate) => String(candidate.requestId) === requestId);
    if (!request) throw new Error(`No pending Codex ${label} matched request id ${requestId}.`);
    return request;
  }
  if (matching.length === 1) return matching[0];
  if (matching.length === 0) throw new Error(`There is no pending Codex ${label}.`);
  throw new Error(`There is more than one pending Codex ${label}; ask which one to answer.`);
}

function answersForQuestionRequest(
  request: PendingCodexRequest,
  questionId: string | undefined,
  answer: string,
): ToolQuestionAnswer[] {
  const raw = request.raw as { raw?: { params?: { questions?: Array<any> } }; params?: { questions?: Array<any> } };
  const questions = raw.params?.questions ?? raw.raw?.params?.questions ?? [];
  if (questions.length === 0) {
    if (!questionId) throw new Error("Codex question payload did not include question ids.");
    return [{ questionId, answers: [answer] }];
  }
  if (questionId && !questions.some((question) => question.id === questionId)) {
    throw new Error(`No pending Codex question matched question id ${questionId}.`);
  }
  if (questionId) {
    return [{ questionId, answers: [answer] }];
  }
  if (!questionId && questions.length > 1) {
    throw new Error("There is more than one Codex question; ask which one to answer.");
  }
  return questions.map((question) => ({
    questionId: question.id,
    answers: [answer],
  }));
}

function approvalDecisionMessage(decision: ApprovalDecision): string {
  if (decision === "accept") return "Approved Codex's request.";
  if (decision === "acceptForSession") return "Approved Codex's request for this session.";
  if (decision === "decline") return "Declined Codex's request.";
  return "Cancelled Codex's request.";
}

function summarizePendingRequest(request: PendingCodexRequest): Record<string, unknown> {
  return {
    requestId: request.requestId,
    method: request.method,
    title: request.title,
    body: request.body,
  };
}
