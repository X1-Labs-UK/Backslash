"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { EditorHeader } from "@/components/editor/EditorHeader";
import { FileTree } from "@/components/editor/FileTree";
import { CodeEditor, CodeEditorHandle } from "@/components/editor/CodeEditor";
import { EditorTabs } from "@/components/editor/EditorTabs";
import { PdfViewer } from "@/components/editor/PdfViewer";
import { BuildLogs } from "@/components/editor/BuildLogs";
import { ChatPanel } from "@/components/editor/ChatPanel";
import { useWebSocket } from "@/hooks/useWebSocket";
import { FileText } from "lucide-react";
import type { PresenceUser, ChatMessage, CursorSelection, DocChange } from "@backslash/shared";

// ─── Types ──────────────────────────────────────────

interface ProjectFile {
  id: string;
  projectId: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  isDirectory: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface Build {
  id: string;
  projectId: string;
  userId: string;
  status: string;
  engine: string;
  logs: string | null;
  durationMs: number | null;
  pdfPath: string | null;
  exitCode: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  engine: string;
  mainFile: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenFile {
  id: string;
  path: string;
}

interface LogError {
  type: string;
  file: string;
  line: number;
  message: string;
}

interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

interface EditorLayoutProps {
  project: Project;
  files: ProjectFile[];
  lastBuild: Build | null;
  role?: "owner" | "viewer" | "editor";
  currentUser?: CurrentUser;
}

// ─── Editor Layout ──────────────────────────────────

export function EditorLayout({
  project,
  files: initialFiles,
  lastBuild: initialBuild,
  role = "owner",
  currentUser = { id: "", email: "", name: "" },
}: EditorLayoutProps) {
  const [files, setFiles] = useState<ProjectFile[]>(initialFiles);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(
    initialBuild?.status === "success"
      ? `/api/projects/${project.id}/pdf?t=${Date.now()}`
      : null
  );
  const [buildStatus, setBuildStatus] = useState(
    initialBuild?.status ?? "idle"
  );
  const [buildLogs, setBuildLogs] = useState(initialBuild?.logs ?? "");
  const [buildDuration, setBuildDuration] = useState<number | null>(
    initialBuild?.durationMs ?? null
  );
  const [buildErrors, setBuildErrors] = useState<LogError[]>([]);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Step 3a: Disable auto-compile if last build failed
  const [autoCompileEnabled, setAutoCompileEnabled] = useState(() => {
    if (initialBuild?.status === "error" || initialBuild?.status === "timeout") {
      return false;
    }
    return true;
  });

  const [dirtyFileIds, setDirtyFileIds] = useState<Set<string>>(new Set());

  // ─── Collaboration State ──────────────────────────

  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  // Step 2b: Remote changes state for CodeEditor
  const [remoteChanges, setRemoteChanges] = useState<{
    fileId: string;
    userId: string;
    changes: DocChange[];
  } | null>(null);

  // Step 2c: Remote cursors state for CodeEditor
  const [remoteCursors, setRemoteCursors] = useState<
    Map<string, { color: string; name: string; selection: CursorSelection }>
  >(new Map());

  // User color map for chat
  const userColorMap = new Map<string, string>();
  presenceUsers.forEach((u) => userColorMap.set(u.userId, u.color));

  const codeEditorRef = useRef<CodeEditorHandle>(null);
  const savedContentRef = useRef<Map<string, string>>(new Map());

  // Step 2a: File contents cache
  const fileContentsRef = useRef<Map<string, string>>(new Map());

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to track activeFileId in callbacks without stale closures
  const activeFileIdRef = useRef<string | null>(null);
  activeFileIdRef.current = activeFileId;

  // ─── WebSocket Integration ────────────────────────

  const {
    sendActiveFile,
    sendCursorMove,
    sendDocChange,
    sendChatMessage,
  } = useWebSocket(project.id, {
    onBuildStatus: (data) => {
      setBuildStatus(data.status);
      setCompiling(true);
      setPdfLoading(true);
    },
    onBuildComplete: (data) => {
      setBuildStatus(data.status);
      setBuildLogs(data.logs ?? "");
      setBuildDuration(data.durationMs);
      setBuildErrors((data.errors as LogError[]) ?? []);
      setCompiling(false);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
      if (data.status === "success") {
        setPdfUrl(`/api/projects/${project.id}/pdf?t=${Date.now()}`);
        // Step 3c: Resume auto-compile on successful build
        setAutoCompileEnabled(true);
      }
      // Step 3b: Disable auto-compile on failure
      if (data.status === "error" || data.status === "timeout") {
        setAutoCompileEnabled(false);
        // Step 3d: Cancel pending auto-save compile on failure
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
      }
      setPdfLoading(false);
    },
    // Presence events
    onPresenceUsers: (users) => {
      setPresenceUsers(users);
    },
    onPresenceJoined: (user) => {
      setPresenceUsers((prev) => {
        if (prev.find((u) => u.userId === user.userId)) return prev;
        return [...prev, user];
      });
    },
    onPresenceLeft: (userId) => {
      setPresenceUsers((prev) => prev.filter((u) => u.userId !== userId));
      // Clear cursor for user who left
      setRemoteCursors((prev) => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
    },
    onPresenceUpdated: (data) => {
      setPresenceUsers((prev) =>
        prev.map((u) =>
          u.userId === data.userId
            ? { ...u, activeFileId: data.activeFileId, activeFilePath: data.activeFilePath }
            : u
        )
      );
    },
    // Chat events
    onChatMessage: (message) => {
      setChatMessages((prev) => [...prev, message]);
    },
    onChatHistory: (messages) => {
      setChatMessages(messages);
    },
    // File events from other users
    onFileCreated: () => {
      refreshFiles();
    },
    onFileDeleted: (data) => {
      refreshFiles();
      // Close the deleted file's tab if open
      if (openFiles.some((f) => f.id === data.fileId)) {
        handleCloseTab(data.fileId);
      }
    },
    // Step 2e: Handle file saved by another user
    onFileSaved: (data) => {
      if (data.fileId !== activeFileIdRef.current) {
        // Invalidate cache so next switch fetches fresh
        fileContentsRef.current.delete(data.fileId);
      } else {
        // Active file was saved by another user — fetch latest
        fetchFileContent(data.fileId);
      }
    },
    // Step 2b: Handle doc changes from other users
    onDocChanged: (data) => {
      const { userId, fileId, changes } = data;
      if (fileId === activeFileIdRef.current) {
        // Trigger granular update in CodeEditor
        setRemoteChanges({ fileId, userId, changes });
      }
      // Also update the cache for non-active files
      applyChangesToCache(fileId, changes);
    },
    // Step 2c: Handle cursor events
    onCursorUpdated: (data) => {
      if (data.fileId === activeFileIdRef.current) {
        setRemoteCursors((prev) => {
          const next = new Map(prev);
          const user = presenceUsers.find((u) => u.userId === data.userId);
          next.set(data.userId, {
            color: user?.color || "#888",
            name: user?.name || "Unknown",
            selection: data.selection,
          });
          return next;
        });
      }
    },
    onCursorCleared: (userId) => {
      setRemoteCursors((prev) => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
    },
  });

  // ─── Helpers ───────────────────────────────────────

  // Apply granular changes to cached string for a file
  const applyChangesToCache = useCallback(
    (fileId: string, changes: DocChange[]) => {
      const cached = fileContentsRef.current.get(fileId);
      if (cached === undefined) return;

      let result = cached;
      // Apply changes in reverse order to preserve positions
      const sorted = [...changes].sort((a, b) => b.from - a.from);
      for (const change of sorted) {
        const from = Math.min(change.from, result.length);
        const to = Math.min(change.to, result.length);
        result = result.slice(0, from) + change.insert + result.slice(to);
      }
      fileContentsRef.current.set(fileId, result);
    },
    []
  );

  // Fetch file content from server
  const fetchFileContent = useCallback(
    async (fileId: string) => {
      try {
        const res = await fetch(
          `/api/projects/${project.id}/files/${fileId}`
        );
        if (res.ok) {
          const data = await res.json();
          const content = data.content ?? "";
          // Update cache
          fileContentsRef.current.set(fileId, content);
          // If this is still the active file, update state
          if (activeFileIdRef.current === fileId) {
            setActiveFileContent(content);
          }
          savedContentRef.current.set(fileId, content);
          setDirtyFileIds((prev) => {
            const next = new Set(prev);
            next.delete(fileId);
            return next;
          });
        }
      } catch {
        if (activeFileIdRef.current === fileId) {
          setActiveFileContent("");
        }
      }
    },
    [project.id]
  );

  // ─── Polling fallback for build completion ────────

  const startBuildPolling = useCallback(() => {
    // Clear any existing poll
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const logsRes = await fetch(`/api/projects/${project.id}/logs`);
        if (!logsRes.ok) return;

        const logsData = await logsRes.json();
        const build = logsData.build;

        if (
          build.status === "success" ||
          build.status === "error" ||
          build.status === "timeout"
        ) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          // Only update if still compiling (WebSocket may have already handled it)
          setCompiling((prev) => {
            if (prev) {
              setBuildStatus(build.status);
              setBuildLogs(build.logs ?? "");
              setBuildDuration(build.durationMs);
              setBuildErrors(logsData.errors ?? []);
              if (build.status === "success") {
                setPdfUrl(
                  `/api/projects/${project.id}/pdf?t=${Date.now()}`
                );
                setAutoCompileEnabled(true);
              }
              if (build.status === "error" || build.status === "timeout") {
                setAutoCompileEnabled(false);
                if (saveTimeoutRef.current) {
                  clearTimeout(saveTimeoutRef.current);
                  saveTimeoutRef.current = null;
                }
              }
              setPdfLoading(false);
            }
            return false;
          });
        }
      } catch {
        // Polling error -- keep trying
      }
    }, 1500);

    // Timeout after 120s
    pollTimeoutRef.current = setTimeout(() => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      setCompiling((prev) => {
        if (prev) {
          setBuildStatus("timeout");
          setAutoCompileEnabled(false);
          setPdfLoading(false);
        }
        return false;
      });
    }, 120_000);
  }, [project.id]);

  // Step 4b: Fetch file content when active file changes — check cache first
  useEffect(() => {
    if (!activeFileId) return;

    // Check cache first
    const cached = fileContentsRef.current.get(activeFileId);
    if (cached !== undefined) {
      setActiveFileContent(cached);
      return;
    }

    // Not cached — fetch from server
    fetchFileContent(activeFileId);
  }, [activeFileId, fetchFileContent]);

  // Step 4a: Open a file in the editor — save content before switching
  const handleFileSelect = useCallback(
    (fileId: string, filePath: string) => {
      // Save current content to cache before switching
      if (activeFileId && activeFileContent !== undefined) {
        fileContentsRef.current.set(activeFileId, activeFileContent);
      }

      // Clear remote cursors when switching files (they belong to different files)
      setRemoteCursors(new Map());

      setActiveFileId(fileId);

      const alreadyOpen = openFiles.some((f) => f.id === fileId);
      if (!alreadyOpen) {
        setOpenFiles((prev) => [...prev, { id: fileId, path: filePath }]);
      }

      // Broadcast active file to other users
      sendActiveFile(fileId, filePath);
    },
    [openFiles, sendActiveFile, activeFileId, activeFileContent]
  );

  // Close a tab
  const handleCloseTab = useCallback(
    (fileId: string) => {
      setOpenFiles((prev) => {
        const next = prev.filter((f) => f.id !== fileId);
        if (activeFileId === fileId) {
          const newActive = next.length > 0 ? next[next.length - 1] : null;
          setActiveFileId(newActive?.id ?? null);
          if (!newActive) setActiveFileContent("");
        }
        return next;
      });
      setDirtyFileIds((prev) => {
        const next = new Set(prev);
        next.delete(fileId);
        return next;
      });
      savedContentRef.current.delete(fileId);
      fileContentsRef.current.delete(fileId);
    },
    [activeFileId]
  );

  // Save file content (with optional auto-compile)
  const handleSave = useCallback(
    async (content: string, autoCompile: boolean) => {
      if (!activeFileId) return;

      try {
        await fetch(`/api/projects/${project.id}/files/${activeFileId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, autoCompile }),
        });

        savedContentRef.current.set(activeFileId, content);
        setDirtyFileIds((prev) => {
          const next = new Set(prev);
          next.delete(activeFileId);
          return next;
        });

        if (autoCompile) {
          setCompiling(true);
          setBuildStatus("queued");
          setPdfLoading(true);
          // Start polling as fallback in case WS doesn't deliver
          startBuildPolling();
        }
      } catch {
        // Save failed silently
      }
    },
    [activeFileId, project.id, startBuildPolling]
  );

  // Debounced save
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEditorChange = useCallback(
    (content: string) => {
      setActiveFileContent(content);

      // Update file contents cache
      if (activeFileId) {
        fileContentsRef.current.set(activeFileId, content);

        const savedContent = savedContentRef.current.get(activeFileId);
        if (savedContent !== content) {
          setDirtyFileIds((prev) => {
            const next = new Set(prev);
            next.add(activeFileId);
            return next;
          });
        } else {
          setDirtyFileIds((prev) => {
            const next = new Set(prev);
            next.delete(activeFileId);
            return next;
          });
        }
      }

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

      const delay = autoCompileEnabled ? 2000 : 1000;

      saveTimeoutRef.current = setTimeout(() => {
        handleSave(content, autoCompileEnabled);
      }, delay);
    },
    [handleSave, activeFileId, autoCompileEnabled]
  );

  // Immediate save (for Ctrl+S) — always compiles
  const handleImmediateSave = useCallback(() => {
    if (!activeFileId) return;
    // Cancel pending debounce
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    handleSave(activeFileContent, true);
  }, [activeFileId, activeFileContent, handleSave]);

  // Compile project (manual)
  const handleCompile = useCallback(async () => {
    if (compiling) return;
    setCompiling(true);
    setBuildStatus("compiling");
    setPdfLoading(true);

    try {
      const res = await fetch(`/api/projects/${project.id}/compile`, {
        method: "POST",
      });

      if (!res.ok) {
        setBuildStatus("error");
        setCompiling(false);
        setPdfLoading(false);
        return;
      }

      // WebSocket handles real-time updates, polling is fallback
      startBuildPolling();
    } catch {
      setBuildStatus("error");
      setCompiling(false);
      setPdfLoading(false);
    }
  }, [compiling, project.id, startBuildPolling]);

  // Keyboard shortcuts: Ctrl+Enter (compile), Ctrl+S (save)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleCompile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleImmediateSave();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCompile, handleImmediateSave]);

  // Refresh file list
  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/files`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files);
      }
    } catch {
      // Silently fail
    }
  }, [project.id]);

  // PDF text selection → highlight in editor
  const handlePdfTextSelect = useCallback((text: string) => {
    codeEditorRef.current?.highlightText(text);
  }, []);

  // Handle error click in build logs
  const handleErrorClick = useCallback(
    (file: string, line: number) => {
      const target = files.find(
        (f) => f.path === file || f.path.endsWith(file)
      );
      if (target) {
        handleFileSelect(target.id, target.path);
      }
    },
    [files, handleFileSelect]
  );

  // Auto-open main tex file on mount
  useEffect(() => {
    if (project.mainFile && files.length > 0 && openFiles.length === 0) {
      const mainFile = files.find((f) => f.path === project.mainFile);
      if (mainFile) {
        handleFileSelect(mainFile.id, mainFile.path);
      }
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-bg-primary">
      {/* Top header */}
      <EditorHeader
        projectName={project.name}
        projectId={project.id}
        compiling={compiling}
        onCompile={handleCompile}
        autoCompileEnabled={autoCompileEnabled}
        onAutoCompileToggle={() => setAutoCompileEnabled((prev) => !prev)}
        buildStatus={buildStatus}
        presenceUsers={presenceUsers}
        currentUserId={currentUser.id}
        role={role}
      />

      {/* Main content area */}
      <div className="flex-1 min-h-0 relative">
        <PanelGroup direction="vertical">
          {/* Editor panels */}
          <Panel defaultSize={80} minSize={40}>
            <PanelGroup direction="horizontal">
              {/* File tree */}
              <Panel defaultSize={15} minSize={10} collapsible>
                <FileTree
                  projectId={project.id}
                  files={files}
                  activeFileId={activeFileId}
                  onFileSelect={handleFileSelect}
                  onFilesChanged={refreshFiles}
                />
              </Panel>

              <PanelResizeHandle className="w-px bg-border hover:bg-accent transition-colors data-[resize-handle-active]:bg-accent" />

              {/* Code editor */}
              <Panel defaultSize={45} minSize={20}>
                <div className="flex h-full flex-col bg-bg-primary">
                  <EditorTabs
                    openFiles={openFiles}
                    activeFileId={activeFileId}
                    dirtyFileIds={dirtyFileIds}
                    onSelectTab={(fileId) => {
                      // Save current content before switching tabs
                      if (activeFileId && activeFileContent !== undefined) {
                        fileContentsRef.current.set(activeFileId, activeFileContent);
                      }
                      setRemoteCursors(new Map());
                      setActiveFileId(fileId);
                    }}
                    onCloseTab={handleCloseTab}
                  />
                  <div className="flex-1 min-h-0">
                    {activeFileId ? (
                      <CodeEditor
                        ref={codeEditorRef}
                        content={activeFileContent}
                        onChange={handleEditorChange}
                        language="latex"
                        onDocChange={(changes) => {
                          if (activeFileId) sendDocChange(activeFileId, changes, Date.now());
                        }}
                        onCursorChange={(selection) => {
                          if (activeFileId) sendCursorMove(activeFileId, selection);
                        }}
                        remoteChanges={remoteChanges}
                        remoteCursors={remoteCursors}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center animate-fade-in">
                        <div className="flex flex-col items-center gap-3 text-center px-4">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-elevated">
                            <FileText className="h-6 w-6 text-text-muted" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-text-secondary">
                              No file open
                            </p>
                            <p className="mt-1 text-xs text-text-muted">
                              Select a file from the sidebar to start editing
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              <PanelResizeHandle className="w-px bg-border hover:bg-accent transition-colors data-[resize-handle-active]:bg-accent" />

              {/* PDF viewer */}
              <Panel defaultSize={40} minSize={15}>
                <PdfViewer pdfUrl={pdfUrl} loading={pdfLoading} onTextSelect={handlePdfTextSelect} />
              </Panel>
            </PanelGroup>
          </Panel>

          <PanelResizeHandle className="h-px bg-border hover:bg-accent transition-colors data-[resize-handle-active]:bg-accent" />

          {/* Build logs */}
          <Panel defaultSize={20} minSize={5} collapsible collapsedSize={4}>
            <BuildLogs
              logs={buildLogs}
              status={buildStatus}
              duration={buildDuration}
              errors={buildErrors}
              onErrorClick={handleErrorClick}
            />
          </Panel>
        </PanelGroup>

        {/* Chat Panel */}
        <ChatPanel
          messages={chatMessages}
          onSendMessage={sendChatMessage}
          currentUserId={currentUser.id}
          userColors={userColorMap}
        />
      </div>
    </div>
  );
}
