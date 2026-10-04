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
- `GATEWAY_ADMIN_EMAILS` is a comma-separated list of identities allowed to
  manage the shared preview catalog. Other authenticated Access users can see
  enabled previews. All users allowed by the Cloudflare Access policy share
  that enabled catalog in this MVP.
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

The container workflow tests every pull request and publishes a SHA-tagged
GHCR image from `main`. Infra should resolve and pin that image digest for
staging and production; `main` is not a deployment artifact.
