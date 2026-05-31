import type { GenericQueryCtx, GenericMutationCtx } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { DataModel, Id } from "./_generated/dataModel";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getCurrentUser(ctx: Ctx) {
  const userId = await getAuthUserId(ctx);
  return userId ? await ctx.db.get(userId) : null;
}

export async function requireUser(ctx: Ctx) {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Authentication required");
  return user;
}

export async function requireWorkspaceMember(
  ctx: Ctx,
  workspaceId: Id<"workspaces">,
) {
  const user = await requireUser(ctx);
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", user._id),
    )
    .unique();
  if (!membership) throw new Error("Workspace access denied");
  return { user, membership };
}

export async function workspaceBySlug(ctx: Ctx, slug: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function requireWorkspaceMemberBySlug(ctx: Ctx, slug: string) {
  const workspace = await workspaceBySlug(ctx, slug);
  if (!workspace) {
    const user = await requireUser(ctx);
    return { user, workspace: null, membership: null };
  }

  return {
    workspace,
    ...(await requireWorkspaceMember(ctx, workspace._id)),
  };
}

export async function requireWorkspaceOwner(
  ctx: Ctx,
  workspaceId: Id<"workspaces">,
) {
  const { user, membership } = await requireWorkspaceMember(ctx, workspaceId);
  if (membership.role !== "owner") throw new Error("Workspace owner required");
  return { user, membership };
}

export async function requireWorkspaceOwnerBySlug(ctx: Ctx, slug: string) {
  const workspace = await workspaceBySlug(ctx, slug);
  if (!workspace) throw new Error("Workspace does not exist");
  return {
    workspace,
    ...(await requireWorkspaceOwner(ctx, workspace._id)),
  };
}

export async function requireDaemonToken(
  ctx: Ctx,
  workspaceSlug: string,
  token: string | undefined,
) {
  if (!token) throw new Error("Daemon token required");

  const workspace = await workspaceBySlug(ctx, workspaceSlug);
  if (!workspace) throw new Error("Workspace does not exist");

  const tokenHash = await sha256(token);
  const tokenDoc = await ctx.db
    .query("daemonTokens")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (
    !tokenDoc ||
    tokenDoc.workspaceId !== workspace._id ||
    tokenDoc.revokedAt !== undefined
  ) {
    throw new Error("Invalid daemon token");
  }

  if ("patch" in ctx.db) {
    await ctx.db.patch(tokenDoc._id, { lastUsedAt: Date.now() });
  }

  return { workspace, token: tokenDoc };
}

export async function requireWorkspaceAccess(
  ctx: Ctx,
  workspaceSlug: string,
  daemonToken?: string,
) {
  if (daemonToken) {
    return await requireDaemonToken(ctx, workspaceSlug, daemonToken);
  }
  return await requireWorkspaceMemberBySlug(ctx, workspaceSlug);
}
