import { stat } from "node:fs/promises";
import type { ServerConfig } from "./config.js";
import { inspectManagedWorktree } from "./git-worktrees.js";
import type {
  WorkspaceSession,
  WorkspaceStatus,
  WorkspaceStore,
} from "./workspace-store.js";
import type {
  WorkspaceActivityLease,
  WorkspaceActivityStore,
} from "./workspace-activity.js";
import { startWorkspaceActivityHeartbeat } from "./workspace-activity.js";
import { WorkspaceRegistry } from "./workspaces.js";

export type WorkspaceReconcileAction =
  | "none"
  | "mark_orphaned"
  | "mark_cleanup_failed"
  | "remove_worktree";

export interface WorkspaceReconcileEntry {
  workspaceId: string;
  root: string;
  mode: WorkspaceSession["mode"];
  status: WorkspaceStatus;
  lastUsedAt: string;
  action: WorkspaceReconcileAction;
  reason: string;
  conversationBound: boolean;
  pathExists?: boolean;
  registered?: boolean;
  dirty?: boolean;
}

export async function inspectWorkspaceSessions(
  config: ServerConfig,
  store: WorkspaceStore,
): Promise<WorkspaceReconcileEntry[]> {
  const entries: WorkspaceReconcileEntry[] = [];
  for (const session of store.listSessions()) {
    entries.push(await inspectWorkspaceSession(config, store, session));
  }
  return entries.sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));
}

export async function applyWorkspaceReconcile(
  config: ServerConfig,
  store: WorkspaceStore,
  workspaceActivity: WorkspaceActivityStore,
  workspaceIds: string[],
): Promise<WorkspaceReconcileEntry[]> {
  const selectedIds = Array.from(new Set(workspaceIds));
  const leases: WorkspaceActivityLease[] = [];
  const stopHeartbeats: Array<() => void> = [];
  const registry = new WorkspaceRegistry(config, store);
  try {
    for (const workspaceId of selectedIds) {
      const lease = workspaceActivity.acquireClose(workspaceId, `prune:${process.pid}`);
      leases.push(lease);
      stopHeartbeats.push(startWorkspaceActivityHeartbeat(lease));
    }

    const entries: WorkspaceReconcileEntry[] = [];
    for (const workspaceId of selectedIds) {
      const session = store.getSession(workspaceId);
      if (!session) throw new Error(`Unknown workspace ID: ${workspaceId}`);
      const entry = await inspectWorkspaceSession(config, store, session);
      if (entry.action === "none") {
        throw new Error(`Workspace is no longer a cleanup candidate: ${workspaceId}`);
      }
      entries.push(entry);
    }

    for (const entry of entries) {
      switch (entry.action) {
        case "mark_orphaned":
          store.setSessionStatus(entry.workspaceId, "orphaned", entry.reason);
          store.deleteConversationBindingsForSession(entry.workspaceId);
          break;
        case "mark_cleanup_failed":
          store.setSessionStatus(entry.workspaceId, "cleanup_failed", entry.reason);
          break;
        case "remove_worktree":
          await registry.closeWorkspace(entry.workspaceId);
          break;
        case "none":
          break;
      }
    }

    return entries;
  } finally {
    for (const stopHeartbeat of stopHeartbeats.reverse()) stopHeartbeat();
    for (const lease of leases.reverse()) lease.release();
  }
}

async function inspectWorkspaceSession(
  config: ServerConfig,
  store: WorkspaceStore,
  session: WorkspaceSession,
): Promise<WorkspaceReconcileEntry> {
  const conversationBound = store.hasConversationBindingsForSession(session.id);
  const base = {
    workspaceId: session.id,
    root: session.root,
    mode: session.mode,
    status: session.status,
    lastUsedAt: session.lastUsedAt,
    conversationBound,
  };

  if (session.status === "open") {
    return {
      ...base,
      action: "none",
      reason: "Workspace is open in the current DevSpace server lifecycle.",
    };
  }
  if (session.status === "closed" || session.status === "orphaned") {
    return {
      ...base,
      action: "none",
      reason: `Workspace history is already ${session.status}.`,
    };
  }

  let pathExists: boolean;
  try {
    pathExists = await directoryExists(session.root);
  } catch (error) {
    return {
      ...base,
      action: "mark_cleanup_failed",
      reason: `Workspace path inspection failed: ${errorMessage(error)}`,
    };
  }
  const inspectedBase = { ...base, pathExists };

  if (session.mode === "checkout") {
    return pathExists
      ? {
          ...inspectedBase,
          action: "none",
          reason: "Detached checkout still exists; DevSpace never deletes user checkouts.",
        }
      : {
          ...inspectedBase,
          action: "mark_orphaned",
          reason: "Checkout path no longer exists; only the persisted handle will be reclassified.",
        };
  }

  if (session.managed && !pathExists) {
    return {
      ...inspectedBase,
      action: "mark_orphaned",
      reason: "Managed worktree path no longer exists.",
    };
  }

  if (!session.managed) {
    return {
      ...inspectedBase,
      action: "none",
      reason: "Worktree is not marked as DevSpace-managed and will not be removed.",
    };
  }
  if (!session.sourceRoot) {
    return {
      ...inspectedBase,
      action: "mark_cleanup_failed",
      reason: "Managed worktree is missing its source checkout path.",
    };
  }

  try {
    const inspection = await inspectManagedWorktree({
      sourceRoot: session.sourceRoot,
      worktreePath: session.root,
      config,
    });
    const inspected = {
      ...base,
      pathExists: inspection.pathExists,
      registered: inspection.registered,
      dirty: inspection.dirty,
    };

    if (!inspection.pathExists) {
      return {
        ...inspected,
        action: "mark_orphaned",
        reason: "Managed worktree path no longer exists.",
      };
    }
    if (!inspection.registered) {
      return {
        ...inspected,
        action: "mark_cleanup_failed",
        reason: "Directory exists but is not registered as a Git worktree; it will not be deleted.",
      };
    }
    if (inspection.dirty) {
      return {
        ...inspected,
        action: "none",
        reason: "Managed worktree has uncommitted changes and will not be removed.",
      };
    }

    return {
      ...inspected,
      action: "remove_worktree",
      reason: "Detached managed worktree is registered and clean.",
    };
  } catch (error) {
    return {
      ...inspectedBase,
      action: "mark_cleanup_failed",
      reason: `Managed worktree inspection failed: ${errorMessage(error)}`,
    };
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
