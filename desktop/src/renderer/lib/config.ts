import hitchConfig from "../../../../hitch.config.json";

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
  import.meta.env.NEXT_PUBLIC_HITCH_PROJECT?.trim() ||
  import.meta.env.VITE_HITCH_PROJECT?.trim() ||
  devProject;

export const HITCH_CONVEX_URL =
  import.meta.env.NEXT_PUBLIC_CONVEX_URL?.trim() ||
  import.meta.env.VITE_CONVEX_URL?.trim() ||
  import.meta.env.CONVEX_URL?.trim() ||
  convexUrlFromDeployment(import.meta.env.CONVEX_DEPLOYMENT) ||
  "";

function convexUrlFromDeployment(deployment: string | undefined): string {
  const value = deployment?.trim();
  if (!value) return "";
  const name = value.includes(":") ? value.split(":")[1] : value;
  return name ? `https://${name}.convex.cloud` : "";
}

export function missingConvexUrlMessage(): string {
  return [
    "Missing NEXT_PUBLIC_CONVEX_URL.",
    "Set NEXT_PUBLIC_CONVEX_URL, VITE_CONVEX_URL, or CONVEX_URL to your Convex deployment URL.",
  ].join(" ");
}
