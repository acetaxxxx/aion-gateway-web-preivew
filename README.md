# Aion Workspace Web Preview Gateway

A browser-facing, read-only preview service for HTML workspaces written by Aion.
Cloudflare Access authenticates requests. With full-data discovery enabled,
the homepage automatically lists HTML pages written by existing Teams, without
MCP enrollment or manual registration. Existing chat and MCP previews remain.

## Runtime contract

- `PREVIEW_SCAN_ROOT` is the personal filesystem subtree Gateway searches. The
  current Aion deployment layout uses `/data/conversations/users`; mount the
  same persistent Aion data directory read-only at `/aion-data`.
- `PREVIEW_TEAM_SCAN_ROOT=/aion-data/teams` enables the separate Shared Team
  subtree, mapped from `AION_TEAM_WORKSPACE_ROOT=/data/teams`. Do not set a
  legacy scan root to all of `/data`. Registry entries persist `workspaceScope: team`
  for Team directories; older entries retain their original personal root and
  URLs without migration. A Team path must match its bound Team ID.
- `PREVIEW_DATA_SCAN_ROOT=/aion-data` enables automatic bounded HTML discovery
  across the full read-only Aion data mount, with `AION_DATA_WORKSPACE_ROOT=/data`
  identifying its Agent-side path. This is a separate discovery scope, not a
  change to legacy roots. Homepage refresh discovers HTML pages, persists fixed
  `/p/<slug>` URLs, and reuses existing registrations without overwriting custom
  names, bindings or disabled state. Non-index `.html`/`.htm` pages can have their
  own entries; homepage labels link directly to the appropriate entry page.
  Non-HTML files are not catalog items. Dependency/hidden paths and symlinks are
  excluded, traversal is bounded, and truncation is reported explicitly.
- `GATEWAY_CATALOG_RENAME_ALLOWED=true` permits same-origin Access-authenticated
  viewers to rename display labels only. The fixed URL and original Aion files
  do not change. It defaults to false; admin enable/disable/removal remain
  separate privileges. Gateway never renames or writes Aion directories.
- `GATEWAY_DATA_DIR` stores only Gateway's preview registry and must be a
  separate persistent directory.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE` are required. Gateway
  validates the `Cf-Access-Jwt-Assertion` signature against the team's Access
  JWKS, then checks issuer, audience, expiry, and email.
- `GATEWAY_MCP_TOKEN` enables the separate `/mcp` Agent endpoint. Use a random
  secret of at least 32 characters, a `GATEWAY_PUBLIC_URL` HTTPS origin, and
  `AION_WORKSPACE_ROOT` (default `/data/conversations/users`) for Agent-to-Gateway
  path mapping. The MCP bearer token authenticates only `/mcp`; it does not grant
  access to browser pages. Missing token disables MCP with HTTP 503.
- `GATEWAY_ADMIN_EMAILS` is a comma-separated list of identities allowed to
  administer the shared preview catalog. Other authenticated Access users can see
  enabled previews. All users allowed by the Cloudflare Access policy share
  that enabled catalog in this MVP.
- Trusted Aion Agents can register/reuse existing directories with `preview_create`,
  retrieve them with `preview_get`, and list them with `preview_list`. Creation
  returns a stable `/p/<slug>` URL, accepts an optional slug and conversation/team
  metadata, and never re-enables an administrator-disabled preview implicitly.
  Register before index.html is ready to start a waiting preview. Tools also
  include `preview_update`, `preview_rename`, `preview_bind_conversation`, and
  `preview_remove`. Renaming keeps the URL; removal never deletes workspace files.
- The portal supports name/Team search, ready/waiting/missing/disabled state,
  modification timestamps, and administrator rename/enable/disable/remove.
- In-page chat uses `AION_BACKEND_URL` (default internal Aion WebUI) and
  server-side `AION_BACKEND_USERS` with the same identity mapping as Aion.
  Supported forms are email:password, email:username:password, and
  username:password. No unmatched identity falls back to another user. Aion
  authorizes every conversation request; a shared preview does not grant chat
  permissions. Team previews resolve the current Team Leader through Aion.
  Team history uses `/api/teams/{id}/conversations/{leader}/messages`; sends use
  `/api/teams/{id}/messages`, retaining the verified caller's identity. Owner and
  active Collaborators are authorized by Aion; revoked/non-members are denied.
  Human messages retain the Core content's actor identity and timestamp.
  Automatically discovered pages without a conversation binding can be opened
  independently of Aion login; they do not show the chat panel until bound.
  Message history and sent/committed responses update through authenticated
  SSE snapshots every second; this is not a token-by-token stream.
- `/api/previews/<slug>/events` sends authenticated SSE updates. Gateway polls
  only previews with connected viewers, debounces file changes, and detects
  HTML/CSS/JS/assets changes on bind mounts. The shell reloads its iframe without
  changing the public URL. Missing entry files show a waiting state and recover
  when the Agent recreates them. Disabled previews close the stream. Connections
  reconnect every minute to recheck Access identity; reconnect also loads the
  latest revision. A preview exceeding 5,000 scanned entries is unavailable to
  live reload and should be registered as a smaller output directory. Symlinked
  files are excluded from polling.
- The preview URL does not reveal a filesystem path. HTML is rendered in an
  iframe with `sandbox="allow-scripts"` and without `allow-same-origin`.
- The app has no write route for Aion files. Its container should run as the
  unprivileged `node` user with the Aion volume mounted `:ro`.

Cloudflare Access must protect the Gateway hostname. Do not publish the
container port directly to the Internet. When Tunnel runs on the host, bind the
origin to loopback and route the new hostname to that loopback port. The Access
application audience used by Gateway must match `CF_ACCESS_AUDIENCE`.
For the requested production hostname `mobsoixe.synoozydoggy.com`, use the new
Gateway application's AUD, not merely the existing Aion application's audience.
The current [Cloudflare setup guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
recommends creating the Access application before publishing the Tunnel route.
Infra owns the exact loopback port and environment configuration. This repository
does not provision DNS, Tunnel routes or Access policies itself.

## Local development

```sh
npm test
npm run test:browser
npm start
```

The local server still requires valid Cloudflare Access configuration and a
request carrying a valid Access JWT. Direct localhost browser requests
intentionally receive `401`; use a Cloudflare Tunnel hostname routed to the
local port for an interactive browser session. For automated tests, request
authentication is injected at the server seam; there is no production
authentication bypass.

## Container

```sh
docker build -t aion-gateway-web-preview:dev .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com \
  -e CF_ACCESS_AUDIENCE=your-access-audience \
  -e GATEWAY_ADMIN_EMAILS=admin@example.com \
  -v /path/to/aion-data:/aion-data:ro \
  -v aion-gateway-data:/gateway-data \
  aion-gateway-web-preview:dev
```

Run `npm ci` first and install the Chromium test browser with
`npx playwright install chromium` for browser tests. CI checks the MCP-to-browser
flow with the official MCP SDK client, iframe isolation, automatic HTML/CSS/JS
refresh, missing-file recovery, and disabling. PRs also validate the container
build. Main publishes the SHA-tagged GHCR image only after Node and browser
tests pass. Infra resolves and pins its digest for staging and production.

## Aion integration

Infra owns the dependency-free stdio bridge, MCP import configuration, and
Agent instructions under `aion-self-deploy/gateway/`. The bridge calls
`http://workspace-gateway:3000/mcp` on the Compose network using the token from
the Aion container environment; no Cloudflare login is needed for Agent calls.
The paired Core release automatically adds the MCP and instructions at Agent
build time via `AIONUI_WORKSPACE_PREVIEW_BRIDGE`, including sessions with explicit
user MCP selection. Restart existing sessions after deployment. The manual
import is only a fallback for older Core images. No files need to be copied or registered by
an administrator for each new website.

The HTTP transport follows the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
via the official SDK. Browser Access authorization and trusted Agent bearer
authorization are separate. `teamId`/`conversationId` currently store metadata;
they do not provide per-user preview visibility. They bind in-page chat while
Aion independently checks conversation access for the verified viewer.
