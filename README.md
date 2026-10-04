# Aion Workspace Web Preview Gateway

A browser-facing, read-only preview service for HTML workspaces written by Aion.
Cloudflare Access authenticates requests; Gateway admins choose which detected
workspace directories are listed to the Access-authorized audience.

## Runtime contract

- `PREVIEW_SCAN_ROOT` is the only filesystem subtree Gateway searches. The
  current Aion deployment layout uses `/data/conversations/users`; mount the
  same persistent Aion data directory read-only at `/aion-data`.
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
  manage the shared preview catalog. Other authenticated Access users can see
  enabled previews. All users allowed by the Cloudflare Access policy share
  that enabled catalog in this MVP.
- Trusted Aion Agents can register/reuse ready directories with `preview_create`,
  retrieve them with `preview_get`, and list them with `preview_list`. Creation
  returns a stable `/p/<slug>` URL, accepts an optional slug and conversation/team
  metadata, and never re-enables an administrator-disabled preview implicitly.
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
Import and enable the MCP in Aion once per user and select it for conversations
that use an explicit MCP selection. No files need to be copied or registered by
an administrator for each new website.

The HTTP transport follows the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
via the official SDK. Browser Access authorization and trusted Agent bearer
authorization are separate. `teamId`/`conversationId` currently store metadata;
they do not provide per-user visibility or in-page chat.
