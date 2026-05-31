import hitchConfig from "../../hitch.config.json";

// Public browser config. NEXT_PUBLIC_* values are what deployed builds should
// use; hitch.config.json keeps local development aligned with the daemon.
export const HITCH_WORKSPACE =
  process.env.NEXT_PUBLIC_HITCH_WORKSPACE?.trim() || hitchConfig.workspace;

export const HITCH_CONVEX_URL =
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() || "";

export function missingConvexUrlMessage(): string {
  return [
    "Missing NEXT_PUBLIC_CONVEX_URL.",
    "Set it to your Convex deployment URL, for example https://your-deployment.convex.cloud.",
  ].join(" ");
}
