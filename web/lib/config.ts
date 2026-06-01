import hitchConfig from "../../hitch.config.json";

// Public browser config. NEXT_PUBLIC_* values are what deployed builds should
// use; hitch.config.json is only a local development fallback.
const localConfig = hitchConfig as {
  activeProject?: string;
  project?: string;
};
const devProject =
  typeof localConfig.activeProject === "string"
    ? localConfig.activeProject
    : typeof localConfig.project === "string"
      ? localConfig.project
      : "";

export const HITCH_PROJECT =
  process.env.NEXT_PUBLIC_HITCH_PROJECT?.trim() || devProject;

export const HITCH_CONVEX_URL =
  process.env.NEXT_PUBLIC_CONVEX_URL?.trim() || "";

export function missingConvexUrlMessage(): string {
  return [
    "Missing NEXT_PUBLIC_CONVEX_URL.",
    "Set it to your Convex deployment URL, for example https://your-deployment.convex.cloud.",
  ].join(" ");
}
