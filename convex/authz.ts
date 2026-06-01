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

export async function requireProjectMember(
  ctx: Ctx,
  projectId: Id<"projects">,
) {
  const user = await requireUser(ctx);
  const membership = await projectMembershipForUser(ctx, projectId, user._id);
  if (!membership) throw new Error("Project access denied");
  return { user, membership };
}

export async function projectMembershipForUser(
  ctx: Ctx,
  projectId: Id<"projects">,
  userId: Id<"users">,
) {
  const membership = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_user", (q) =>
      q.eq("projectId", projectId).eq("userId", userId),
    )
    .unique();
  return membership;
}

export async function projectBySlug(ctx: Ctx, slug: string) {
  return await ctx.db
    .query("projects")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function requireProjectMemberBySlug(ctx: Ctx, slug: string) {
  const project = await projectBySlug(ctx, slug);
  if (!project) {
    const user = await requireUser(ctx);
    return { user, project: null, membership: null };
  }

  return {
    project,
    ...(await requireProjectMember(ctx, project._id)),
  };
}

export async function requireProjectOwner(
  ctx: Ctx,
  projectId: Id<"projects">,
) {
  const { user, membership } = await requireProjectMember(ctx, projectId);
  if (membership.role !== "owner") throw new Error("Project owner required");
  return { user, membership };
}

export async function requireProjectOwnerBySlug(ctx: Ctx, slug: string) {
  const project = await projectBySlug(ctx, slug);
  if (!project) throw new Error("Project does not exist");
  return {
    project,
    ...(await requireProjectOwner(ctx, project._id)),
  };
}

export async function requireDeviceToken(
  ctx: Ctx,
  token: string | undefined,
) {
  if (!token) throw new Error("Device token required");

  const tokenHash = await sha256(token);
  const tokenDoc = await ctx.db
    .query("deviceTokens")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!tokenDoc || tokenDoc.revokedAt !== undefined) {
    throw new Error("Invalid device token");
  }

  const user = await ctx.db.get(tokenDoc.userId);
  if (!user) throw new Error("Device token user not found");

  if ("patch" in ctx.db) {
    await ctx.db.patch(tokenDoc._id, { lastUsedAt: Date.now() });
  }

  return { user, token: tokenDoc };
}

export async function requireProjectAccess(
  ctx: Ctx,
  projectSlug: string,
  deviceToken?: string,
) {
  if (deviceToken) {
    const { user, token } = await requireDeviceToken(ctx, deviceToken);
    const project = await projectBySlug(ctx, projectSlug);
    if (!project) throw new Error("Project does not exist");
    const membership = await projectMembershipForUser(ctx, project._id, user._id);
    if (!membership) throw new Error("Project access denied");
    return { user, project, membership, token };
  }
  return await requireProjectMemberBySlug(ctx, projectSlug);
}
