import { query } from "./_generated/server";
import { getCurrentUser } from "./authz";

// The signed-in user's identity for the account footer (avatar + name + email).
// GitHub OAuth populates these on the `users` table via @convex-dev/auth.
// Returns null when unauthenticated so the UI can fall back gracefully.
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;
    return {
      name: user.name ?? null,
      email: user.email ?? null,
      image: user.image ?? null,
    };
  },
});
