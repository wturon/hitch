import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronBuilderBin = resolve(
  __dirname,
  "../../node_modules/.bin/electron-builder",
);
const baseConfigPath = resolve(__dirname, "../electron-builder.yml");
const generatedConfigPath = resolve(
  __dirname,
  "../dist-builder/electron-builder.generated.yml",
);

const updateFeedUrl = (process.env.HITCH_UPDATE_FEED_URL ?? "").trim();
const publishProvider = (process.env.HITCH_PUBLISH_PROVIDER ?? "").trim();
const githubOwner = (process.env.HITCH_GITHUB_OWNER ?? "").trim();
const githubRepo = (process.env.HITCH_GITHUB_REPO ?? "").trim();
const githubReleaseType = (
  process.env.HITCH_GITHUB_RELEASE_TYPE ?? "release"
).trim();
let configPath = baseConfigPath;

if (publishProvider === "github") {
  if (!githubOwner || !githubRepo) {
    throw new Error(
      "HITCH_GITHUB_OWNER and HITCH_GITHUB_REPO are required for GitHub publishing.",
    );
  }

  const baseConfig = readFileSync(baseConfigPath, "utf8").replace(/\s*$/, "");
  mkdirSync(dirname(generatedConfigPath), { recursive: true });
  writeFileSync(
    generatedConfigPath,
    `${baseConfig}

publish:
  - provider: github
    owner: ${JSON.stringify(githubOwner)}
    repo: ${JSON.stringify(githubRepo)}
    releaseType: ${JSON.stringify(githubReleaseType)}
`,
    "utf8",
  );
  configPath = generatedConfigPath;
  console.log(
    `[package] GitHub publishing enabled: ${githubOwner}/${githubRepo} (${githubReleaseType})`,
  );
} else if (updateFeedUrl) {
  const baseConfig = readFileSync(baseConfigPath, "utf8").replace(/\s*$/, "");
  mkdirSync(dirname(generatedConfigPath), { recursive: true });
  writeFileSync(
    generatedConfigPath,
    `${baseConfig}

publish:
  - provider: generic
    url: ${JSON.stringify(updateFeedUrl)}
`,
    "utf8",
  );
  configPath = generatedConfigPath;
  console.log(`[package] update feed enabled: ${updateFeedUrl}`);
} else {
  console.warn(
    "[package] HITCH_UPDATE_FEED_URL is not set; building a manually distributed DMG without auto-update metadata.",
  );
}

const result = spawnSync(
  electronBuilderBin,
  [
    "--mac",
    "--arm64",
    "--config",
    configPath,
    ...(publishProvider === "github" ? ["--publish", "always"] : []),
  ],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
