import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const desktopDir = resolve(__dirname, "..");

function fail(message) {
  console.error(`[release:desktop] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    fail(`command failed: ${command} ${args.join(" ")}`);
  }
}

function output(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    ...options,
  }).trim();
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    draft: false,
    prerelease: false,
    skipPush: false,
  };
  let versionArg = null;

  for (const arg of argv) {
    if (arg === "--draft") {
      options.draft = true;
    } else if (arg === "--prerelease") {
      options.prerelease = true;
    } else if (arg === "--skip-push") {
      options.skipPush = true;
    } else if (arg.startsWith("--")) {
      fail(`unknown option: ${arg}`);
    } else if (!versionArg) {
      versionArg = arg;
    } else {
      fail(`unexpected argument: ${arg}`);
    }
  }

  if (options.draft && options.prerelease) {
    fail("choose only one of --draft or --prerelease");
  }

  return { versionArg, options };
}

function packageJsonVersion() {
  const pkg = JSON.parse(
    readFileSync(resolve(desktopDir, "package.json"), "utf8"),
  );
  return pkg.version;
}

function ownerAndRepoFromOrigin() {
  const remote = output("git", ["remote", "get-url", "origin"]);
  const match = remote.match(
    /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
  );
  if (!match) {
    fail(`could not infer GitHub owner/repo from origin: ${remote}`);
  }
  return { owner: match[1], repo: match[2] };
}

function ensureCleanWorktree() {
  const status = output("git", ["status", "--porcelain"]);
  if (status) {
    fail(
      [
        "working tree has uncommitted changes. Commit or stash them before releasing.",
        "",
        status,
      ].join("\n"),
    );
  }
}

function ensureMainBranch() {
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    fail(`desktop releases must be cut from main; current branch is ${branch || "<detached>"}`);
  }
}

function ensureGitHubToken() {
  if (
    process.env.GITHUB_RELEASE_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN
  ) {
    return;
  }

  const ghToken = spawnSync("gh", ["auth", "token"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (ghToken.status === 0 && ghToken.stdout.trim()) {
    process.env.GH_TOKEN = ghToken.stdout.trim();
    return;
  }

  fail(
    "GitHub publishing needs GITHUB_RELEASE_TOKEN, GH_TOKEN, GITHUB_TOKEN, or an authenticated `gh` CLI.",
  );
}

function ensureTagAvailable(tag) {
  const ref = `refs/tags/${tag}`;
  const local = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (local.status === 0) fail(`local tag already exists: ${tag}`);

  const remote = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", ref],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  if (remote.status === 0) fail(`remote tag already exists: ${tag}`);
}

function npmVersion(versionArg) {
  if (!versionArg) return packageJsonVersion();

  run("npm", [
    "version",
    versionArg,
    "--workspace",
    "desktop",
    "--no-git-tag-version",
  ]);
  return packageJsonVersion();
}

const { versionArg, options } = parseArgs(process.argv.slice(2));

loadEnvFile(resolve(repoRoot, ".env.production"));
ensureCleanWorktree();
ensureMainBranch();
ensureGitHubToken();

const { owner, repo } = ownerAndRepoFromOrigin();
const version = npmVersion(versionArg);
const tag = `v${version}`;
const releaseType = options.draft
  ? "draft"
  : options.prerelease
    ? "prerelease"
    : "release";

ensureTagAvailable(tag);

if (versionArg) {
  run("git", ["add", "desktop/package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Release desktop ${tag}`]);
}

run("git", ["tag", "-a", tag, "-m", `Hitch ${tag}`]);

if (!options.skipPush) {
  run("git", ["push", "origin", "HEAD:main"]);
  run("git", ["push", "origin", tag]);
}

process.env.HITCH_PUBLISH_PROVIDER = "github";
process.env.HITCH_GITHUB_OWNER = owner;
process.env.HITCH_GITHUB_REPO = repo;
process.env.HITCH_GITHUB_RELEASE_TYPE = releaseType;

console.log(
  `[release:desktop] Publishing Hitch ${tag} to github.com/${owner}/${repo} (${releaseType})`,
);

run("npm", ["-w", "desktop", "run", "package"]);

console.log(
  `[release:desktop] Done. Initial install URL: https://github.com/${owner}/${repo}/releases/tag/${tag}`,
);
