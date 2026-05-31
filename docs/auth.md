# Auth And Workspace Access

Hitch uses Convex Auth for human web sessions and separate workspace-scoped
tokens for local daemons.

## Human Auth

The first provider is GitHub OAuth through Convex Auth.

Required Convex environment variables:

```bash
npx convex env set AUTH_GITHUB_ID <github-oauth-client-id>
npx convex env set AUTH_GITHUB_SECRET <github-oauth-client-secret>
```

Convex Auth also requires:

```bash
npx @convex-dev/auth
```

That command configures `SITE_URL`, `JWT_PRIVATE_KEY`, and `JWKS` for the active
Convex deployment.

## Workspace Authorization

The target authorization model is:

- signed-in users can access a workspace only through `workspaceMembers`;
- owners can manage daemon tokens;
- local daemons authenticate with daemon tokens instead of browser sessions.

During the migration from the original string-only workspace model, a signed-in
user can still access a legacy workspace slug until that slug is claimed into a
`workspaces` document. Once the workspace document exists, membership checks are
enforced.

## Daemon Tokens

Create a token from the board sidebar:

1. Sign in.
2. Open **Daemon tokens**.
3. Create a token.
4. Copy the token immediately.
5. Put it in `.env.local` or `.env`:

```bash
HITCH_DAEMON_TOKEN=hitchdt_...
```

The daemon sends this token with file sync, heartbeat, and command queue calls.
Only token hashes are stored in Convex.

Tokens can be revoked from the same **Daemon tokens** dialog. Revoked tokens
stop authenticating future daemon requests.
