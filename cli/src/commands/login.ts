import { hostname } from "node:os";

import { configPath, deleteConfig, loadConfig, saveConfig } from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { LOGIN_HELP, LOGOUT_HELP } from "../help.js";
import { parseFlags } from "../parse.js";
import { promptHidden, promptLine } from "../prompt.js";

// The same dance the desktop main process does (hitchServer.ts): sign in with
// email/password, use the session cookie ONCE to mint an API key named for
// this machine, store only {serverUrl, apiKey, apiKeyId}, discard the cookie.
//
// better-auth's CSRF check rejects POSTs with a missing/null Origin, so every
// /api/auth/* call sends the server's own origin (always trusted — it's the
// baseURL). Node fetch, unlike a browser, lets us set it.

const NONINTERACTIVE_EXAMPLE =
  "  hitch login --server http://localhost:3010 --email will@example.com --password s3cret";

async function authErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {
    /* non-JSON error body */
  }
  return `Request failed (${response.status})`;
}

export async function runLogin(args: string[]): Promise<void> {
  const { values } = parseFlags(
    args,
    {
      server: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
    },
    LOGIN_HELP,
  );
  if (values.help) {
    console.log(LOGIN_HELP);
    return;
  }

  const stored = loadConfig();
  const serverUrl = (values.server ?? stored?.serverUrl)?.replace(/\/+$/, "");
  if (!serverUrl) {
    throw new UsageError(
      `--server is required (no server stored yet). For example:\n` +
        `  hitch login --server http://localhost:3010`,
    );
  }

  let email = values.email;
  let password = values.password;
  if (email === undefined || password === undefined) {
    if (!process.stdin.isTTY) {
      throw new UsageError(
        `Not a terminal — pass credentials as flags for non-interactive login:\n${NONINTERACTIVE_EXAMPLE}`,
      );
    }
    email ??= await promptLine("Email: ");
    password ??= await promptHidden("Password: ");
  }
  if (!email || !password) {
    throw new UsageError(`Email and password are both required. For example:\n${NONINTERACTIVE_EXAMPLE}`);
  }

  const authHeaders = (extra: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    origin: serverUrl,
    ...extra,
  });

  let signIn: Response;
  try {
    signIn = await fetch(`${serverUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    throw new CliError(
      `Could not reach ${serverUrl} (${String((error as { cause?: { code?: string } }).cause?.code ?? error)}).\n` +
        `Check the URL and that the server is running, then retry:\n` +
        `  hitch login --server ${serverUrl}`,
    );
  }
  if (!signIn.ok) {
    const detail = await authErrorMessage(signIn);
    if (signIn.status === 401) {
      throw new CliError(
        `Sign-in rejected: ${detail}.\n` +
          `Check the email/password. Accounts are created in the Hitch desktop app.`,
      );
    }
    throw new CliError(`Sign-in failed: ${detail}`);
  }

  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new CliError("Sign-in succeeded but returned no session cookie.");

  const create = await fetch(`${serverUrl}/api/auth/api-key/create`, {
    method: "POST",
    headers: authHeaders({ cookie }),
    body: JSON.stringify({ name: `cli ${hostname()}` }),
  });
  if (!create.ok) throw new CliError(`API key creation failed: ${await authErrorMessage(create)}`);
  const created = (await create.json()) as { id?: unknown; key?: unknown };
  if (typeof created.key !== "string" || !created.key) {
    throw new CliError("API key creation returned no key.");
  }

  saveConfig({
    serverUrl,
    apiKey: created.key,
    apiKeyId: typeof created.id === "string" ? created.id : undefined,
  });
  console.log(`Logged in to ${serverUrl} as ${email}.`);
  console.log(`Credentials stored in ${configPath()}. Try: hitch tasks list`);
}

export async function runLogout(args: string[]): Promise<void> {
  const { values } = parseFlags(args, {}, LOGOUT_HELP);
  if (values.help) {
    console.log(LOGOUT_HELP);
    return;
  }
  const config = loadConfig();
  if (!config) {
    console.log("Not logged in — nothing to do.");
    return;
  }
  // Best-effort server-side revocation: the key authenticates its own
  // deletion. An unreachable server must not block a local logout.
  if (config.apiKeyId) {
    try {
      await fetch(`${config.serverUrl}/api/auth/api-key/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: config.serverUrl,
          "x-api-key": config.apiKey,
        },
        body: JSON.stringify({ keyId: config.apiKeyId }),
      });
    } catch {
      /* offline logout still clears local creds */
    }
  }
  deleteConfig();
  console.log(`Logged out of ${config.serverUrl}; removed ${configPath()}.`);
}
