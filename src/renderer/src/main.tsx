import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppEvent,
  AppState,
  CodexThreadTokenUsage,
  PendingCodexRequest,
  ReasoningEffort,
  ToolQuestionAnswer,
  VoiceChat,
  VoiceSession,
} from "../../shared/types";
import { RealtimeVoiceClient } from "./realtimeClient";
import "./styles.css";

const emptyState: AppState = {
  baseFolder: "",
  sessions: [],
  archivedSessions: [],
  activeSession: null,
  runtime: {
    ready: false,
    activeSessionId: null,
    activeChatId: null,
    activeTurnId: null,
    status: "Loading.",
    threadStatus: null,
    tokenUsage: null,
    pendingRequests: [],
    chats: [],
    showSessionChats: false,
  },
  codexSettings: {
    sessionModel: null,
    sessionReasoningEffort: null,
    nextTurnModel: null,
    nextTurnReasoningEffort: null,
    activeTurnModel: null,
    activeTurnReasoningEffort: null,
    defaultModel: null,
    defaultReasoningEffort: null,
    models: [],
  },
  realtime: {
    available: false,
    model: "gpt-realtime-1.5",
    voice: "marin",
    reason: null,
    apiKeySource: null,
    apiKeyEncrypted: false,
  },
};

type AppWindowKind = "voice" | "debug";

type ContextMenuTarget =
  | {
      kind: "session";
      sessionId: string;
      label: string;
      x: number;
      y: number;
    }
  | {
      kind: "chat";
      sessionId: string;
      chatId: string;
      label: string;
      x: number;
      y: number;
    };

type ArchivedChat = {
  sessionId: string;
  sessionName: string;
  chat: VoiceChat;
};

function appWindowKind(): AppWindowKind {
  const kind = new URLSearchParams(window.location.search).get("window");
  return kind === "debug" ? "debug" : "voice";
}

function App(): React.ReactElement {
  const [windowKind] = useState<AppWindowKind>(() => appWindowKind());
  const [state, setState] = useState<AppState>(emptyState);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [sessionName, setSessionName] = useState("");
  const [message, setMessage] = useState("");
  const [steer, setSteer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState("Realtime disconnected.");
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const voiceRef = useRef<RealtimeVoiceClient | null>(null);

  useEffect(() => {
    if (!error) return undefined;
    const timeoutId = window.setTimeout(() => setError(null), 15000);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  useEffect(() => {
    document.title = windowKind === "debug" ? "Codex Voice Debug" : "Codex Voice";
    void refreshState();
    void refreshEvents();
    const offState = window.codexVoice.onAppState(setState);
    const offEvent = window.codexVoice.onAppEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, 250));
      if (event.source === "codex" && event.kind === "serverRequest") {
        voiceRef.current?.speakPendingRequest(event.raw as PendingCodexRequest);
      } else if (event.source === "codex" && event.kind === "error") {
        voiceRef.current?.speakStatus(event.message);
      }
    });
    return () => {
      offState();
      offEvent();
      voiceRef.current?.disconnect();
    };
  }, []);

  async function refreshState(): Promise<void> {
    setState(await window.codexVoice.getState());
  }

  async function refreshEvents(): Promise<void> {
    setEvents(await window.codexVoice.getEvents());
  }

  async function clearEvents(): Promise<void> {
    await window.codexVoice.clearEvents();
    setEvents([]);
  }

  async function logEvent(event: AppEvent): Promise<void> {
    await window.codexVoice.logEvent(event);
  }

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      await refreshState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function toggleVoice(): Promise<void> {
    if (voiceRef.current?.connected || voiceConnected) {
      voiceRef.current?.disconnect();
      voiceRef.current = null;
      setVoiceConnected(false);
      setVoiceConnecting(false);
      setVoiceStatus("Realtime disconnected.");
      return;
    }
    if (voiceConnecting) return;
    await runAction(async () => {
      setVoiceConnecting(true);
      const client = new RealtimeVoiceClient({
        onConnectionChange: (connected, label) => {
          setVoiceConnected(connected);
          setVoiceConnecting(!connected && label !== "Realtime data channel closed.");
          setVoiceStatus(label);
        },
        onLog: (event) => {
          void window.codexVoice.logEvent(event);
        },
      });
      voiceRef.current = client;
      try {
        await client.connect();
      } catch (caught) {
        if (voiceRef.current === client) voiceRef.current = null;
        throw caught;
      } finally {
        setVoiceConnecting(false);
      }
    });
  }

  async function handleOrbAction(): Promise<void> {
    if (state.runtime.activeTurnId) {
      await runAction(() => window.codexVoice.interruptCodex());
      return;
    }
    await toggleVoice();
  }

  async function openDebugWindow(): Promise<void> {
    await runAction(() => window.codexVoice.openDebugWindow());
  }

  if (windowKind === "debug") {
    return (
      <DebugDashboard
        state={state}
        events={events}
        error={error}
        sessionName={sessionName}
        message={message}
        steer={steer}
        setSessionName={setSessionName}
        setMessage={setMessage}
        setSteer={setSteer}
        onDismissError={() => setError(null)}
        onAction={runAction}
        onClearEvents={clearEvents}
        onRefresh={refreshState}
        onLogEvent={logEvent}
      />
    );
  }

  return (
    <VoiceHome
      state={state}
      error={error}
      voiceConnected={voiceConnected}
      voiceConnecting={voiceConnecting}
      onAction={runAction}
      onDismissError={() => setError(null)}
      onOrbAction={handleOrbAction}
      onRefresh={refreshState}
      onShowDebug={openDebugWindow}
      onToggleVoice={toggleVoice}
    />
  );
}

function VoiceHome({
  state,
  error,
  voiceConnected,
  voiceConnecting,
  onAction,
  onDismissError,
  onOrbAction,
  onRefresh,
  onShowDebug,
  onToggleVoice,
}: {
  state: AppState;
  error: string | null;
  voiceConnected: boolean;
  voiceConnecting: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onDismissError: () => void;
  onOrbAction: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onShowDebug: () => Promise<void>;
  onToggleVoice: () => Promise<void>;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [switchChatOpen, setSwitchChatOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [query, setQuery] = useState("");
  const activeSession = state.activeSession;
  const featuredSession = activeSession ?? state.sessions[0] ?? null;
  const sessionChats = useMemo(
    () => chatSummariesForSession(activeSession, state),
    [activeSession, state],
  );
  const archivedChats = useMemo(() => archivedChatsForSessions(state.sessions), [state.sessions]);
  const archivedCount = state.archivedSessions.length + archivedChats.length;
  const recentSessions = state.sessions.slice(0, 3);
  const modelScope = activeSession ? "session" : "nextTurn";
  const effectiveModel =
    state.codexSettings.nextTurnModel ??
    state.codexSettings.sessionModel ??
    state.codexSettings.defaultModel ??
    "";
  const effectiveEffort =
    state.codexSettings.nextTurnReasoningEffort ??
    state.codexSettings.sessionReasoningEffort ??
    state.codexSettings.defaultReasoningEffort ??
    "xhigh";
  const filteredSessions = state.sessions.filter((session) => {
    const haystack = [
      session.displayName,
      session.folderPath,
      session.lastStatus ?? "",
      session.lastSummary ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const voiceState = voiceStateLabel(state, voiceConnected, voiceConnecting);

  useEffect(() => {
    setChatsOpen(false);
  }, [activeSession?.id]);

  useEffect(() => {
    setChatsOpen(state.runtime.showSessionChats);
  }, [state.runtime.showSessionChats]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  async function createNewSession(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onAction(async () => {
      await window.codexVoice.createSession(newName || undefined);
      setNewName("");
      setNewOpen(false);
    });
  }

  async function resumeSession(sessionId: string): Promise<void> {
    await onAction(() => window.codexVoice.resumeSession(sessionId));
    setBrowseOpen(false);
  }

  async function createNewChat(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newChatName.trim();
    if (!name) return;
    await onAction(async () => {
      await window.codexVoice.createChat(name);
      setNewChatName("");
      setNewChatOpen(false);
      setChatsOpen(true);
    });
  }

  async function switchChat(chatId: string): Promise<void> {
    await onAction(async () => {
      await window.codexVoice.switchChat(chatId);
      setSwitchChatOpen(false);
      setChatsOpen(true);
    });
  }

  function openSessionContextMenu(
    event: React.MouseEvent<HTMLElement>,
    session: VoiceSession,
  ): void {
    event.preventDefault();
    setContextMenu({
      kind: "session",
      sessionId: session.id,
      label: session.displayName,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openChatContextMenu(event: React.MouseEvent<HTMLElement>, chat: ChatSummary): void {
    if (!activeSession) return;
    event.preventDefault();
    setContextMenu({
      kind: "chat",
      sessionId: activeSession.id,
      chatId: chat.id,
      label: chat.title,
      x: event.clientX,
      y: event.clientY,
    });
  }

  async function archiveContextTarget(): Promise<void> {
    const target = contextMenu;
    if (!target) return;
    setContextMenu(null);
    if (target.kind === "session") {
      await onAction(() => window.codexVoice.archiveSession(target.sessionId));
      return;
    }
    await onAction(() => window.codexVoice.archiveChat(target.chatId, target.sessionId));
  }

  async function restoreSession(sessionId: string): Promise<void> {
    await onAction(() => window.codexVoice.restoreSession(sessionId));
  }

  async function restoreChat(sessionId: string, chatId: string): Promise<void> {
    await onAction(() => window.codexVoice.restoreChat(chatId, sessionId));
  }

  async function saveApiKey(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onAction(async () => {
      await window.codexVoice.saveOpenAiApiKey(apiKey);
      setApiKey("");
      setApiKeyOpen(false);
    });
  }

  async function clearApiKey(): Promise<void> {
    await onAction(async () => {
      await window.codexVoice.clearOpenAiApiKey();
      setApiKey("");
      setApiKeyOpen(false);
    });
  }

  return (
    <main className="voice-home">
      <div className="voice-home-content">
        <header className="voice-home-header">
          <h1>
            Codex Voice <span>BETA</span>
          </h1>
          <div className="voice-menu-wrap">
            <button
              className="voice-icon-button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((current) => !current)}
            >
              <EllipsisIcon />
            </button>
            {menuOpen && (
              <div className="voice-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onShowDebug();
                  }}
                >
                  Debug UI
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void onRefresh();
                  }}
                >
                  Refresh
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setArchivedOpen(true);
                  }}
                >
                  Archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setApiKeyOpen(true);
                  }}
                >
                  OpenAI API key
                </button>
                {voiceConnected && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onToggleVoice();
                    }}
                  >
                    Disconnect voice
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="voice-home-scroll">
          <section className="voice-model-picker" aria-label="Model settings">
            <button
              className="voice-model-trigger"
              aria-expanded={modelOpen}
              onClick={() => setModelOpen((current) => !current)}
            >
              <span>{formatModelName(effectiveModel)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatEffort(effectiveEffort)}</span>
              <DownIcon />
            </button>

            {modelOpen && (
              <div className="voice-model-panel">
                <label className="voice-model-field">
                  Model
                  <span className="voice-model-select-wrap">
                    <select
                      value={effectiveModel}
                      onChange={(event) =>
                        void onAction(() =>
                          window.codexVoice.setCodexSettings(
                            { model: event.target.value || null },
                            modelScope,
                          ),
                        )
                      }
                    >
                      {state.codexSettings.models.length === 0 && (
                        <option value={effectiveModel}>{formatModelName(effectiveModel)}</option>
                      )}
                      {state.codexSettings.models.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName || formatModelName(model.model)}
                        </option>
                      ))}
                    </select>
                    <DownIcon />
                  </span>
                </label>

                <div className="voice-effort-list">
                  <span>Reasoning effort</span>
                  {(["low", "medium", "high", "xhigh"] as ReasoningEffort[]).map((effort) => (
                    <button
                      key={effort}
                      className={effort === effectiveEffort ? "selected" : ""}
                      onClick={() =>
                        void onAction(() =>
                          window.codexVoice.setCodexSettings({ reasoningEffort: effort }, modelScope),
                        )
                      }
                    >
                      {formatEffort(effort)}
                      {effort === effectiveEffort && <CheckIcon />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="voice-hero" aria-label="Voice status">
            <button
              className={`voice-orb ${voiceState.tone}`}
              aria-label={state.runtime.activeTurnId ? "Interrupt Codex" : "Start voice"}
              onClick={() => void onOrbAction()}
            >
              <span className="voice-orb-shine" />
            </button>
            <div className="voice-state-line">
              <WaveformIcon />
              <span>{voiceState.label}</span>
            </div>
          </section>

          {error && <ErrorOverlay message={error} onDismiss={onDismissError} />}

          <section className="voice-session-region" aria-label="Sessions">
            <FeaturedSessionCard
              activeSessionId={state.runtime.activeSessionId}
              session={featuredSession}
              chatsOpen={chatsOpen}
              onCreate={() => setNewOpen(true)}
              onResume={resumeSession}
              onOpenMenu={openSessionContextMenu}
              onToggleChats={() => {
                const next = !chatsOpen;
                setChatsOpen(next);
                void onAction(() => window.codexVoice.showSessionChats(next));
              }}
            />

            {chatsOpen && activeSession ? (
              <SessionChatsPanel
                chats={sessionChats}
                onNewChat={() => setNewChatOpen(true)}
                onSwitchChat={() => setSwitchChatOpen(true)}
                onSelectChat={switchChat}
                onOpenChatMenu={openChatContextMenu}
              />
            ) : (
              <div className="voice-actions">
                <button className="voice-action-button" onClick={() => setNewOpen(true)}>
                  <PlusIcon />
                  <span>New session</span>
                </button>
                <button className="voice-action-button" onClick={() => setBrowseOpen(true)}>
                  <FolderIcon />
                  <span>Browse sessions</span>
                </button>
              </div>
            )}

            {(!chatsOpen || !activeSession) && (
              <div className="recent-block">
                <h2>Recent Sessions</h2>
                <div className="recent-list">
                  {recentSessions.map((session) => (
                    <button
                      key={session.id}
                      className="recent-row"
                      onClick={() => void resumeSession(session.id)}
                      onContextMenu={(event) => openSessionContextMenu(event, session)}
                    >
                      <span>
                        <strong>{session.displayName}</strong>
                        <small>{formatSessionTime(session.updatedAt)}</small>
                      </span>
                      <ChevronIcon />
                    </button>
                  ))}
                  {recentSessions.length === 0 && (
                    <div className="recent-empty">Recent sessions will appear here.</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="voice-footer">
          <span className={`voice-dot ${state.runtime.ready ? "ready" : ""}`} />
          <span>{state.runtime.ready ? "Codex app-server connected" : "Codex app-server starting"}</span>
          <button className="voice-footer-gear" aria-label="Open debug UI" onClick={() => void onShowDebug()}>
            <GearIcon />
          </button>
        </footer>
      </div>

      {newOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <form className="voice-dialog" onSubmit={(event) => void createNewSession(event)}>
            <div className="voice-dialog-header">
              <h2>New session</h2>
              <button type="button" aria-label="Close" onClick={() => setNewOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Session name
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Voice Session"
              />
            </label>
            <div className="voice-dialog-actions">
              <button type="button" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="voice-primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {browseOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <section className="voice-dialog browse-dialog" aria-label="Browse sessions">
            <div className="voice-dialog-header">
              <h2>Browse sessions</h2>
              <button type="button" aria-label="Close" onClick={() => setBrowseOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Search
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
              />
            </label>
            <div className="browse-list">
              {filteredSessions.map((session) => (
                <button
                  key={session.id}
                  className="browse-row"
                  onClick={() => void resumeSession(session.id)}
                  onContextMenu={(event) => openSessionContextMenu(event, session)}
                >
                  <FolderIcon />
                  <span>
                    <strong>{session.displayName}</strong>
                    <small>{formatSessionTime(session.updatedAt)}</small>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
              {filteredSessions.length === 0 && <p className="browse-empty">No matching sessions.</p>}
            </div>
          </section>
        </div>
      )}

      {newChatOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <form className="voice-dialog" onSubmit={(event) => void createNewChat(event)}>
            <div className="voice-dialog-header">
              <h2>New chat</h2>
              <button type="button" aria-label="Close" onClick={() => setNewChatOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Chat name
              <input
                autoFocus
                value={newChatName}
                onChange={(event) => setNewChatName(event.target.value)}
                placeholder="Research thread"
              />
            </label>
            <div className="voice-dialog-actions">
              <button type="button" onClick={() => setNewChatOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="voice-primary" disabled={!newChatName.trim()}>
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {switchChatOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <section className="voice-dialog browse-dialog" aria-label="Switch chat">
            <div className="voice-dialog-header">
              <h2>Switch chat</h2>
              <button type="button" aria-label="Close" onClick={() => setSwitchChatOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className="browse-list">
              {sessionChats.map((chat) => (
                <button
                  key={chat.id}
                  className={`browse-row ${chat.active ? "selected-chat" : ""}`}
                  onClick={() => void switchChat(chat.id)}
                >
                  <span className={`chat-status-dot ${chat.tone}`} />
                  <span>
                    <strong>{chat.title}</strong>
                    <small>{chat.detail}</small>
                  </span>
                  <span className="browse-row-trailing">
                    {chat.active && <span className="active-chat-pill">Active</span>}
                    <ChevronIcon />
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {apiKeyOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <form className="voice-dialog api-key-dialog" onSubmit={(event) => void saveApiKey(event)}>
            <div className="voice-dialog-header">
              <h2>OpenAI API key</h2>
              <button type="button" aria-label="Close" onClick={() => setApiKeyOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <p className="voice-dialog-note">
              {state.realtime.available
                ? `A key is configured from ${
                    state.realtime.apiKeySource === "environment" ? "the environment" : "saved settings"
                  }.`
                : "Add a key to enable Realtime voice."}
            </p>
            <label className="voice-field">
              API key
              <input
                autoFocus
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={state.realtime.available ? "Enter a new key to replace saved key" : "sk-..."}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="voice-dialog-actions split-actions">
              <button
                type="button"
                onClick={() => void clearApiKey()}
              >
                Clear saved key
              </button>
              <span />
              <button type="button" onClick={() => setApiKeyOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="voice-primary" disabled={!apiKey.trim()}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {archivedOpen && (
        <ArchivedDialog
          sessions={state.archivedSessions}
          chats={archivedChats}
          onClose={() => setArchivedOpen(false)}
          onRestoreSession={restoreSession}
          onRestoreChat={restoreChat}
        />
      )}

      {contextMenu && (
        <ArchiveContextMenu
          target={contextMenu}
          onArchive={() => void archiveContextTarget()}
        />
      )}
    </main>
  );
}

function FeaturedSessionCard({
  activeSessionId,
  chatsOpen,
  session,
  onCreate,
  onResume,
  onOpenMenu,
  onToggleChats,
}: {
  activeSessionId: string | null;
  chatsOpen: boolean;
  session: VoiceSession | null;
  onCreate: () => void;
  onResume: (sessionId: string) => Promise<void>;
  onOpenMenu: (event: React.MouseEvent<HTMLElement>, session: VoiceSession) => void;
  onToggleChats: () => void;
}): React.ReactElement {
  if (!session) {
    return (
      <button className="featured-session-card empty-feature" onClick={onCreate}>
        <span className="voice-folder-tile">
          <FolderIcon />
        </span>
        <span className="featured-copy">
          <strong>No active session</strong>
          <small>Create a session to begin</small>
        </span>
        <ChevronIcon />
      </button>
    );
  }

  const active = session.id === activeSessionId;
  return (
    <button
      className={`featured-session-card ${chatsOpen && active ? "expanded" : ""}`}
      aria-expanded={active ? chatsOpen : undefined}
      onContextMenu={(event) => onOpenMenu(event, session)}
      onClick={() => {
        if (active) {
          onToggleChats();
          return;
        }
        void onResume(session.id);
      }}
    >
      <span className="voice-folder-tile">
        <FolderIcon />
      </span>
      <span className="featured-copy">
        <strong>{session.displayName}</strong>
        <small>
          {formatSessionTime(session.updatedAt)}
          {active && (
            <>
              <span className="voice-meta-dot">.</span>
              <span className="active-session-text">Active session</span>
            </>
          )}
        </small>
      </span>
      <ChevronIcon className={chatsOpen && active ? "chevron-open" : ""} />
    </button>
  );
}

type ChatSummary = {
  id: string;
  title: string;
  detail: string;
  tone: "active" | "waiting" | "idle";
  active: boolean;
};

function SessionChatsPanel({
  chats,
  onNewChat,
  onSwitchChat,
  onSelectChat,
  onOpenChatMenu,
}: {
  chats: ChatSummary[];
  onNewChat: () => void;
  onSwitchChat: () => void;
  onSelectChat: (chatId: string) => Promise<void>;
  onOpenChatMenu: (event: React.MouseEvent<HTMLElement>, chat: ChatSummary) => void;
}): React.ReactElement {
  const activeChat = chats.find((chat) => chat.active) ?? null;
  return (
    <div className="session-chats-panel">
      <div className="session-chats-header">
        <div>
          <h2>Chats in this session</h2>
          {activeChat && (
            <p>
              Active chat: <strong>{activeChat.title}</strong>
            </p>
          )}
        </div>
        <span>{chats.length}</span>
      </div>
      <div className="session-chat-list">
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`session-chat-row ${chat.active ? "active" : ""}`}
            onClick={() => void onSelectChat(chat.id)}
            onContextMenu={(event) => onOpenChatMenu(event, chat)}
          >
            <span className={`chat-status-dot ${chat.tone}`} />
            <span className="session-chat-copy">
              <strong>{chat.title}</strong>
              <small>{chat.detail}</small>
            </span>
            {chat.active && (
              <span className="session-chat-trailing">
                <span className="active-chat-pill">Active</span>
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="voice-actions chat-actions">
        <button className="voice-action-button" type="button" onClick={onNewChat}>
          <PlusIcon />
          <span>New chat</span>
        </button>
        <button className="voice-action-button" type="button" onClick={onSwitchChat}>
          <SwitchIcon />
          <span>Switch chat</span>
        </button>
      </div>
    </div>
  );
}

function ArchiveContextMenu({
  target,
  onArchive,
}: {
  target: ContextMenuTarget;
  onArchive: () => void;
}): React.ReactElement {
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 188));
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 54));
  return (
    <div
      className="voice-context-menu"
      role="menu"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={onArchive}>
        {target.kind === "session" ? "Archive session" : "Archive chat"}
      </button>
    </div>
  );
}

function ArchivedDialog({
  sessions,
  chats,
  onClose,
  onRestoreSession,
  onRestoreChat,
}: {
  sessions: VoiceSession[];
  chats: ArchivedChat[];
  onClose: () => void;
  onRestoreSession: (sessionId: string) => Promise<void>;
  onRestoreChat: (sessionId: string, chatId: string) => Promise<void>;
}): React.ReactElement {
  const empty = sessions.length === 0 && chats.length === 0;
  return (
    <div className="voice-modal-backdrop" role="presentation">
      <section className="voice-dialog archived-dialog" aria-label="Archived">
        <div className="voice-dialog-header">
          <h2>Archived</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {empty ? (
          <p className="browse-empty">Archived chats and sessions will appear here.</p>
        ) : (
          <div className="archived-sections">
            {sessions.length > 0 && (
              <section className="archived-section">
                <h3>Sessions</h3>
                <div className="archived-list">
                  {sessions.map((session) => (
                    <article key={session.id} className="archived-row">
                      <FolderIcon />
                      <span>
                        <strong>{session.displayName}</strong>
                        <small>{session.archivedAt ? formatSessionTime(session.archivedAt) : "Archived"}</small>
                      </span>
                      <button type="button" onClick={() => void onRestoreSession(session.id)}>
                        Restore
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {chats.length > 0 && (
              <section className="archived-section">
                <h3>Chats</h3>
                <div className="archived-list">
                  {chats.map(({ sessionId, sessionName, chat }) => (
                    <article key={chat.id} className="archived-row">
                      <span className="chat-status-dot idle" />
                      <span>
                        <strong>{chat.displayName}</strong>
                        <small>
                          {sessionName}
                          <span className="voice-meta-dot">.</span>
                          {chat.archivedAt ? formatSessionTime(chat.archivedAt) : "Archived"}
                        </small>
                      </span>
                      <button type="button" onClick={() => void onRestoreChat(sessionId, chat.id)}>
                        Restore
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ErrorOverlay({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="error-overlay" role="alert" aria-live="assertive">
      <p>{message}</p>
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}

function DebugDashboard({
  state,
  events,
  error,
  sessionName,
  message,
  steer,
  setSessionName,
  setMessage,
  setSteer,
  onDismissError,
  onAction,
  onClearEvents,
  onRefresh,
  onLogEvent,
}: {
  state: AppState;
  events: AppEvent[];
  error: string | null;
  sessionName: string;
  message: string;
  steer: string;
  setSessionName: React.Dispatch<React.SetStateAction<string>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setSteer: React.Dispatch<React.SetStateAction<string>>;
  onDismissError: () => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onClearEvents: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onLogEvent: (event: AppEvent) => Promise<void>;
}): React.ReactElement {
  const activeFolder = state.activeSession?.folderPath ?? "No active session.";
  const activeChatName =
    (state.activeSession?.chats ?? []).find((chat) => chat.id === state.runtime.activeChatId && !chat.archivedAt)
      ?.displayName ?? "none";
  const effectiveNextModel =
    state.codexSettings.nextTurnModel ??
    state.codexSettings.sessionModel ??
    state.codexSettings.defaultModel ??
    "default";
  const effectiveNextEffort =
    state.codexSettings.nextTurnReasoningEffort ??
    state.codexSettings.sessionReasoningEffort ??
    state.codexSettings.defaultReasoningEffort ??
    "default";

  return (
    <main className="debug-shell app-shell">
      <header className="topbar">
        <div>
          <h1>Codex Voice Debug</h1>
          <p>Voice is the front door. Codex owns the computer work.</p>
        </div>
        <div className="status-stack">
          <StatusPill label={state.runtime.ready ? "Codex ready" : "Codex starting"} tone={state.runtime.ready ? "good" : "warn"} />
          <StatusPill label={`Next: ${effectiveNextModel} / ${effectiveNextEffort}`} tone="muted" />
          <StatusPill label="Voice in main window" tone="muted" />
        </div>
      </header>

      {error && <ErrorOverlay message={error} onDismiss={onDismissError} />}

      <section className="workspace-bar">
        <div>
          <span className="label">Base folder</span>
          <code>{state.baseFolder || "Loading..."}</code>
        </div>
        <div>
          <span className="label">Active folder</span>
          <code>{activeFolder}</code>
        </div>
      </section>

      <section className="grid">
        <aside className="panel sessions-panel">
          <div className="panel-header">
            <h2>Sessions</h2>
            <button onClick={() => void onRefresh()}>Refresh</button>
          </div>
          <div className="new-session-row">
            <input
              value={sessionName}
              onChange={(event) => setSessionName(event.target.value)}
              placeholder="Session name"
            />
            <button
              className="primary"
              onClick={() =>
                void onAction(async () => {
                  await window.codexVoice.createSession(sessionName || undefined);
                  setSessionName("");
                })
              }
            >
              New
            </button>
          </div>
          <div className="session-list">
            {state.sessions.map((session) => (
              <button
                key={session.id}
                className={`session-card ${session.id === state.runtime.activeSessionId ? "active" : ""}`}
                onClick={() => void onAction(() => window.codexVoice.resumeSession(session.id))}
              >
                <strong>{session.displayName}</strong>
                <span>{new Date(session.updatedAt).toLocaleString()}</span>
                <small>{session.lastStatus ?? "No status yet."}</small>
              </button>
            ))}
            {state.sessions.length === 0 && <p className="empty">No voice sessions yet.</p>}
          </div>
        </aside>

        <section className="panel command-panel">
          <div className="panel-header">
            <h2>Codex Control</h2>
          </div>
          <p className="help">
            {state.realtime.available
              ? `Realtime voice is controlled from the main Codex Voice window. Model: ${state.realtime.model}, voice: ${state.realtime.voice}.`
              : state.realtime.reason}
          </p>

          <div className="status-card">
            <span className="label">Codex status</span>
            <strong>{state.runtime.status}</strong>
            <small>
              Chat: {activeChatName} | Thread: {state.activeSession?.codexThreadId ?? "none"} | Turn:{" "}
              {state.runtime.activeTurnId ?? "none"}
            </small>
            <small>
              Thread state: {state.runtime.threadStatus ?? "unknown"} | Context:{" "}
              {formatTokenUsage(state.runtime.tokenUsage)}
            </small>
          </div>

          <CodexSettingsPanel state={state} onAction={onAction} />
          <NativeSlashPanel />

          <label className="stacked-input">
            Send request to Codex or native slash command
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Type a request, /status, /model, /model next gpt-5.5 high, /review, /compact, /mcp verbose..."
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              onClick={() =>
                void onAction(async () => {
                  await window.codexVoice.sendToCodex(message);
                  setMessage("");
                })
              }
            >
              Send
            </button>
            <button
              onClick={() =>
                void onAction(async () => {
                  const summary = await window.codexVoice.summarizeSession(state.activeSession?.id);
                  await onLogEvent({
                    at: new Date().toISOString(),
                    source: "app",
                    kind: "summary",
                    message: summary,
                  });
                })
              }
            >
              Summarize Active
            </button>
            <button className="danger" onClick={() => void onAction(() => window.codexVoice.interruptCodex())}>
              Interrupt
            </button>
          </div>

          <label className="stacked-input compact">
            Steer active turn
            <div className="inline-form">
              <input
                value={steer}
                onChange={(event) => setSteer(event.target.value)}
                placeholder="Actually, use the PDF from yesterday..."
              />
              <button
                onClick={() =>
                  void onAction(async () => {
                    await window.codexVoice.steerCodex(steer);
                    setSteer("");
                  })
                }
              >
                Steer
              </button>
            </div>
          </label>
        </section>

        <section className="panel approvals-panel">
          <div className="panel-header">
            <h2>Approvals / Questions</h2>
            <span>{state.runtime.pendingRequests.length}</span>
          </div>
          <p className="help">Voice can answer with allow, allow for this session, decline, or cancel.</p>
          {state.runtime.pendingRequests.length === 0 ? (
            <p className="empty">Nothing waiting on the user.</p>
          ) : (
            state.runtime.pendingRequests.map((request) => (
              <PendingRequestCard key={String(request.requestId)} request={request} onAction={onAction} />
            ))
          )}
        </section>

        <section className="panel event-panel">
          <div className="panel-header">
            <h2>Event Log</h2>
            <button onClick={() => void onClearEvents()}>Clear</button>
          </div>
          <div className="event-list">
            {events.map((event, index) => (
              <article key={`${event.at}-${index}`} className={`event ${event.source}`}>
                <div>
                  <strong>{event.kind}</strong>
                  <span>{event.source}</span>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                </div>
                <p>{event.message}</p>
              </article>
            ))}
            {events.length === 0 && <p className="empty">No events yet.</p>}
          </div>
        </section>
      </section>
    </main>
  );
}

function voiceStateLabel(
  state: AppState,
  voiceConnected: boolean,
  voiceConnecting: boolean,
): { label: string; tone: "off" | "listening" | "working" | "connecting" } {
  if (state.runtime.activeTurnId) return { label: "Working", tone: "working" };
  if (voiceConnecting) return { label: "Connecting", tone: "connecting" };
  if (voiceConnected) return { label: "Listening", tone: "listening" };
  return { label: "Voice off", tone: "off" };
}

function chatSummariesForSession(session: VoiceSession | null, state: AppState): ChatSummary[] {
  if (!session) return [];
  return (session.chats ?? []).filter((chat) => !chat.archivedAt).map((chat) => {
    const runtime = (state.runtime.chats ?? []).find((candidate) => candidate.chatId === chat.id);
    const waiting = Boolean(runtime?.pendingRequests.length);
    const working = Boolean(runtime?.activeTurnId);
    return {
      id: chat.id,
      title: chat.displayName,
      detail: runtime?.status ?? chat.lastStatus ?? "Idle",
      tone: waiting ? "waiting" : working ? "active" : "idle",
      active: chat.id === state.runtime.activeChatId,
    };
  });
}

function archivedChatsForSessions(sessions: VoiceSession[]): ArchivedChat[] {
  return sessions.flatMap((session) =>
    (session.chats ?? [])
      .filter((chat) => chat.archivedAt)
      .map((chat) => ({
        sessionId: session.id,
        sessionName: session.displayName,
        chat,
      })),
  );
}

function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDelta = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (dayDelta === 0) return `Today, ${time}`;
  if (dayDelta === 1) return `Yesterday, ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + `, ${time}`;
}

function formatModelName(model: string | null): string {
  if (!model) return "Default";
  return model.replace(/^gpt-/i, "GPT-");
}

function formatEffort(effort: string | null): string {
  if (!effort) return "Default";
  if (effort === "xhigh") return "Extra High";
  return effort.slice(0, 1).toUpperCase() + effort.slice(1);
}

function FolderIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.75 6.75a2 2 0 0 1 2-2h4.15l2.05 2.25h6.3a2 2 0 0 1 2 2v8.25a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V6.75Z" />
    </svg>
  );
}

function PlusIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function DownIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="voice-chevron">
      <path d="m6.5 9 5.5 5.5L17.5 9" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5.5 12.5 4.25 4.25L18.5 7.25" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string } = {}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={["voice-chevron", className].filter(Boolean).join(" ")}
    >
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </svg>
  );
}

function SwitchIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10l-3-3M17 17H7l3 3M17 7l-4 4M7 17l4-4" />
    </svg>
  );
}

function WaveformIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 28 24" aria-hidden="true" className="waveform-icon">
      <path d="M4 10v4M8 6v12M12 3.75v16.5M16 7v10M20 10v4M24 8.5v7" />
    </svg>
  );
}

function EllipsisIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="ellipsis-icon">
      <circle cx="6.5" cy="12" r="1.45" />
      <circle cx="12" cy="12" r="1.45" />
      <circle cx="17.5" cy="12" r="1.45" />
    </svg>
  );
}

function GearIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 3.9 10.25 2h3.5l.75 1.9 1.55.65 1.85-.8 2.45 2.45-.8 1.85.65 1.55 1.9.75v3.5l-1.9.75-.65 1.55.8 1.85-2.45 2.45-1.85-.8-1.55.65-.75 1.9h-3.5l-.75-1.9-1.55-.65-1.85.8-2.45-2.45.8-1.85-.65-1.55-1.9-.75v-3.5l1.9-.75.65-1.55-.8-1.85 2.45-2.45 1.85.8 1.55-.65Z" />
      <path d="M8.75 12a3.25 3.25 0 1 0 6.5 0 3.25 3.25 0 0 0-6.5 0Z" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

function CodexSettingsPanel({
  state,
  onAction,
}: {
  state: AppState;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const efforts: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const models = state.codexSettings.models;
  const sessionModel = state.codexSettings.sessionModel ?? "";
  const nextTurnModel = state.codexSettings.nextTurnModel ?? "";
  const sessionEffort = state.codexSettings.sessionReasoningEffort ?? "";
  const nextTurnEffort = state.codexSettings.nextTurnReasoningEffort ?? "";

  return (
    <section className="settings-panel">
      <div className="settings-grid">
        <SettingReadout
          label="Default"
          model={state.codexSettings.defaultModel ?? "unknown"}
          effort={state.codexSettings.defaultReasoningEffort ?? "unknown"}
        />
        <SettingReadout
          label="Session"
          model={state.codexSettings.sessionModel ?? "default"}
          effort={state.codexSettings.sessionReasoningEffort ?? "default"}
        />
        <SettingReadout
          label="Next Turn"
          model={state.codexSettings.nextTurnModel ?? "session/default"}
          effort={state.codexSettings.nextTurnReasoningEffort ?? "session/default"}
        />
        <SettingReadout
          label="Active Turn"
          model={state.codexSettings.activeTurnModel ?? "none"}
          effort={state.codexSettings.activeTurnReasoningEffort ?? "none"}
        />
      </div>

      <div className="settings-controls">
        <label>
          Session model
          <select
            value={sessionModel}
            disabled={!state.activeSession}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings({ model: event.target.value || null }, "session"),
              )
            }
          >
            <option value="">Default ({state.codexSettings.defaultModel ?? "unknown"})</option>
            {models.map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName} ({model.model})
              </option>
            ))}
          </select>
        </label>

        <label>
          Session effort
          <select
            value={sessionEffort}
            disabled={!state.activeSession}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { reasoningEffort: (event.target.value || null) as ReasoningEffort | null },
                  "session",
                ),
              )
            }
          >
            <option value="">Default ({state.codexSettings.defaultReasoningEffort ?? "unknown"})</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>

        <label>
          Next-turn model
          <select
            value={nextTurnModel}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings({ model: event.target.value || null }, "nextTurn"),
              )
            }
          >
            <option value="">Use session/default</option>
            {models.map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName} ({model.model})
              </option>
            ))}
          </select>
        </label>

        <label>
          Next-turn effort
          <select
            value={nextTurnEffort}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { reasoningEffort: (event.target.value || null) as ReasoningEffort | null },
                  "nextTurn",
                ),
              )
            }
          >
            <option value="">Use session/default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function SettingReadout({
  label,
  model,
  effort,
}: {
  label: string;
  model: string;
  effort: string;
}): React.ReactElement {
  return (
    <div className="setting-readout">
      <span>{label}</span>
      <strong>{model}</strong>
      <small>{effort}</small>
    </div>
  );
}

function NativeSlashPanel(): React.ReactElement {
  const backed = ["/status", "/model", "/review", "/compact", "/mcp", "/apps", "/plugins"];
  const session = ["/new", "/resume"];
  const recognized = ["/feedback", "/plan-mode", "/diff", "/init", "/permissions", "/agent", "/stop"];
  return (
    <section className="slash-panel">
      <div>
        <span className="label">App-server backed</span>
        <div className="slash-chip-row">
          {backed.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Voice session controls</span>
        <div className="slash-chip-row">
          {session.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Recognized, not wired</span>
        <div className="slash-chip-row muted">
          {recognized.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatTokenUsage(usage: CodexThreadTokenUsage | null): string {
  if (!usage) return "not reported";
  const total = usage.total.totalTokens;
  if (!usage.modelContextWindow) return `${total.toLocaleString()} tokens`;
  return `${total.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()}`;
}

function StatusPill({ label, tone }: { label: string; tone: "good" | "warn" | "muted" }): React.ReactElement {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function PendingRequestCard({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  if (request.method === "item/tool/requestUserInput") {
    return <ToolQuestionCard request={request} onAction={onAction} />;
  }

  return (
    <article className="pending-card">
      <h3>{request.title}</h3>
      <pre>{request.body || request.method}</pre>
      <div className="button-row wrap">
        <button className="primary" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "accept"))}>
          Accept
        </button>
        <button onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "acceptForSession"))}>
          Accept Session
        </button>
        <button onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "decline"))}>
          Decline
        </button>
        <button className="danger" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "cancel"))}>
          Cancel
        </button>
      </div>
    </article>
  );
}

function ToolQuestionCard({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const questions = useMemo(() => {
    const raw = request.raw as { params?: { questions?: Array<any> } };
    return raw.params?.questions ?? [];
  }, [request.raw]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const payload: ToolQuestionAnswer[] = questions.map((question) => ({
    questionId: question.id,
    answers: [answers[question.id] || question.options?.[0]?.label || ""].filter(Boolean),
  }));

  return (
    <article className="pending-card">
      <h3>{request.title}</h3>
      {questions.map((question) => (
        <label key={question.id} className="stacked-input compact">
          {question.question}
          {Array.isArray(question.options) && question.options.length > 0 ? (
            <select
              value={answers[question.id] ?? question.options[0].label}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
            >
              {question.options.map((option: { label: string; description: string }) => (
                <option key={option.label} value={option.label}>
                  {option.label} - {option.description}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={answers[question.id] ?? ""}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder="Answer"
              type={question.isSecret ? "password" : "text"}
            />
          )}
        </label>
      ))}
      <button className="primary" onClick={() => void onAction(() => window.codexVoice.answerToolQuestion(request.requestId, payload))}>
        Send Answer
      </button>
    </article>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
