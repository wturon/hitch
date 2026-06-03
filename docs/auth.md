# Auth And Project Access

Hitch uses Convex Auth for human web sessions and user-scoped device tokens for
local daemons.

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

For local Hitch Desktop development, `SITE_URL` must point at the Vite renderer
that Electron loads:

```bash
npx convex env set SITE_URL http://127.0.0.1:5173
```

If `SITE_URL` is still `http://localhost:3000`, GitHub sign-in can complete and
then redirect the Electron window away from the Vite renderer.

## Project Authorization

The target authorization model is:

- signed-in users can access a project only through `projectMembers`;
- each local daemon authenticates as a user/device with a device token;
- daemon access to a project is computed from that user's project membership.

Project APIs use Convex project document IDs. Project names are display-only;
membership checks are enforced directly against the requested project ID.

## Device Tokens

Create a token from the board sidebar:

1. Sign in.
2. Open **Device tokens**.
3. Create a token.
4. Copy the token immediately.
5. Put it in `.env.local` or `.env`:

```bash
HITCH_DEVICE_TOKEN=hitchdev_...
```

The daemon sends this token with file sync, heartbeat, and command queue calls.
Only token hashes are stored in Convex. The token itself is not project-scoped;
the server resolves the token to a user and checks `projectMembers` for each
requested project.

Tokens can be revoked from the same **Device tokens** dialog. Revoked tokens
stop authenticating future daemon requests.
