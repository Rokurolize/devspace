import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { workspaceResourceKey } from "./workspace-resource.js";

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1_000;

export type WorkspaceActivityKind = "operation" | "process" | "local_agent" | "close";

export class WorkspaceBusyError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly reason: "active" | "closing" | "open_alias",
  ) {
    super(
      reason === "closing"
        ? `Workspace ${workspaceId} is being closed and cannot start new activity.`
        : reason === "open_alias"
          ? `Workspace ${workspaceId} shares its directory with another open workspace. Close that workspace before removing this one.`
        : `Workspace ${workspaceId} has active operations. Stop them before closing the workspace.`,
    );
    this.name = "WorkspaceBusyError";
  }
}

export interface WorkspaceActivityLease {
  id: string;
  workspaceId: string;
  kind: WorkspaceActivityKind;
  heartbeatIntervalMs: number;
  heartbeat(): void;
  release(): void;
}

export interface WorkspaceActivityStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export class WorkspaceActivityStore {
  private readonly database: DatabaseHandle;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(stateDir: string, options: WorkspaceActivityStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error("Workspace activity lease TTL must be a positive integer.");
    }
  }

  acquireShared(
    workspaceId: string,
    kind: Exclude<WorkspaceActivityKind, "close">,
    ownerId: string = randomUUID(),
  ): WorkspaceActivityLease {
    return this.acquire(workspaceId, kind, ownerId, false);
  }

  acquireClose(workspaceId: string, ownerId: string = randomUUID()): WorkspaceActivityLease {
    return this.acquire(workspaceId, "close", ownerId, true);
  }

  adopt(
    leaseId: string,
    workspaceId: string,
    kind: Exclude<WorkspaceActivityKind, "close">,
  ): WorkspaceActivityLease {
    const adopt = this.database.sqlite.transaction(() => {
      const now = this.now();
      this.deleteExpired(now);
      const result = this.database.sqlite
        .prepare(
          `update workspace_activity_leases
           set expires_at = ?, updated_at = ?
           where lease_id = ?
             and workspace_id = ?
             and kind = ?
             and expires_at > ?`,
        )
        .run(
          now + this.ttlMs,
          new Date(now).toISOString(),
          leaseId,
          workspaceId,
          kind,
          now,
        );
      if (result.changes !== 1) {
        throw new Error(`Workspace activity lease is missing or expired: ${leaseId}`);
      }
    });
    adopt.immediate();
    return this.lease(leaseId, workspaceId, kind);
  }

  close(): void {
    this.database.close();
  }

  private acquire(
    workspaceId: string,
    kind: WorkspaceActivityKind,
    ownerId: string,
    exclusive: boolean,
  ): WorkspaceActivityLease {
    const leaseId = `wal_${randomUUID().replaceAll("-", "")}`;
    const acquire = this.database.sqlite.transaction(
      (): WorkspaceBusyError["reason"] | undefined => {
        const now = this.now();
        this.deleteExpired(now);
        const resourceKey = this.resourceKey(workspaceId);
        if (
          exclusive &&
          this.isManagedWorktree(workspaceId) &&
          this.hasOpenAlias(workspaceId, resourceKey)
        ) {
          return "open_alias";
        }
        const blocker = exclusive
          ? this.database.sqlite
              .prepare(
                `select kind from workspace_activity_leases
                 where resource_key = ? and expires_at > ?
                 limit 1`,
              )
              .get(resourceKey, now)
          : this.database.sqlite
              .prepare(
                `select kind from workspace_activity_leases
                 where resource_key = ? and kind = 'close' and expires_at > ?
                 limit 1`,
              )
              .get(resourceKey, now);
        if (blocker) {
          return exclusive ? "active" : "closing";
        }

        const timestamp = new Date(now).toISOString();
        this.database.sqlite
          .prepare(
            `insert into workspace_activity_leases (
               lease_id, workspace_id, resource_key, kind, owner_id,
               expires_at, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            leaseId,
            workspaceId,
            resourceKey,
            kind,
            ownerId,
            now + this.ttlMs,
            timestamp,
            timestamp,
          );
        return undefined;
      },
    );
    const blockedReason = acquire.immediate();
    if (blockedReason) {
      throw new WorkspaceBusyError(workspaceId, blockedReason);
    }
    return this.lease(leaseId, workspaceId, kind);
  }

  private lease(
    leaseId: string,
    workspaceId: string,
    kind: WorkspaceActivityKind,
  ): WorkspaceActivityLease {
    let released = false;
    return {
      id: leaseId,
      workspaceId,
      kind,
      heartbeatIntervalMs: Math.max(10, Math.floor(this.ttlMs / 3)),
      heartbeat: () => {
        if (released) return;
        const now = this.now();
        const result = this.database.sqlite
          .prepare(
            `update workspace_activity_leases
             set expires_at = ?, updated_at = ?
             where lease_id = ?`,
          )
          .run(now + this.ttlMs, new Date(now).toISOString(), leaseId);
        if (result.changes !== 1) {
          throw new Error(`Workspace activity lease is missing or expired: ${leaseId}`);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        try {
          this.database.sqlite
            .prepare("delete from workspace_activity_leases where lease_id = ?")
            .run(leaseId);
        } catch {
          // Do not let cleanup failure escape a process or tool completion
          // callback. The row remains fail-closed until its bounded expiry.
        }
      },
    };
  }

  private deleteExpired(now: number): void {
    this.database.sqlite
      .prepare("delete from workspace_activity_leases where expires_at <= ?")
      .run(now);
  }

  private resourceKey(workspaceId: string): string {
    const session = this.database.sqlite
      .prepare("select root from workspace_sessions where id = ?")
      .get(workspaceId) as { root: string } | undefined;
    return workspaceResourceKey(session?.root, workspaceId);
  }

  private hasOpenAlias(workspaceId: string, resourceKey: string): boolean {
    const sessions = this.database.sqlite
      .prepare(
        `select id, root from workspace_sessions
         where status = 'open' and id <> ?`,
      )
      .all(workspaceId) as Array<{ id: string; root: string }>;
    return sessions.some(
      (session) => workspaceResourceKey(session.root, session.id) === resourceKey,
    );
  }

  private isManagedWorktree(workspaceId: string): boolean {
    const session = this.database.sqlite
      .prepare("select mode, managed from workspace_sessions where id = ?")
      .get(workspaceId) as { mode: string; managed: string } | undefined;
    return session?.mode === "worktree" && session.managed === "true";
  }
}

export function startWorkspaceActivityHeartbeat(
  lease: WorkspaceActivityLease,
): () => void {
  const timer = setInterval(() => {
    try {
      lease.heartbeat();
    } catch {
      // Keep retrying. A transient SQLite lock must not silently turn a live
      // activity into an expired lease while the owning operation continues.
    }
  }, lease.heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function withWorkspaceActivity<T>(
  store: WorkspaceActivityStore,
  workspaceId: string,
  kind: Exclude<WorkspaceActivityKind, "close">,
  ownerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = store.acquireShared(workspaceId, kind, ownerId);
  const stopHeartbeat = startWorkspaceActivityHeartbeat(lease);
  try {
    return await operation();
  } finally {
    stopHeartbeat();
    lease.release();
  }
}
