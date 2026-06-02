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
