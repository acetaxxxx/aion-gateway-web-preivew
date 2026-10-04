import { createPublicKey, verify as verifySignature } from 'node:crypto';

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 60 * 60 * 1000;
const jwksCache = new Map();

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

async function getJwks(teamDomain, fetchImpl, forceRefresh = false) {
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Cloudflare Access JWKS returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Cloudflare Access JWKS has no keys');
  jwksCache.set(teamDomain, { keys: body.keys, expiresAt: Date.now() + JWKS_CACHE_MS });
  return body.keys;
}

export async function verifyAccessToken(token, config, fetchImpl = fetch) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Access token');

  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('Unsupported Access token signature');
  }

  let keys = await getJwks(config.accessTeamDomain, fetchImpl);
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) {
    keys = await getJwks(config.accessTeamDomain, fetchImpl, true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA');
  }
  if (!jwk) throw new Error('Access token signing key was not found');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifySignature('RSA-SHA256', signed, publicKey, signature)) {
    throw new Error('Invalid Access token signature');
  }

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.accessAudience)) throw new Error('Access token audience mismatch');
  if (claims.iss !== `https://${config.accessTeamDomain}`) throw new Error('Access token issuer mismatch');
  if (!Number.isFinite(claims.exp) || claims.exp <= now - CLOCK_SKEW_SECONDS) {
    throw new Error('Access token is expired');
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    throw new Error('Access token is not active yet');
  }
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) {
    throw new Error('Access token has no valid email identity');
  }

  return { email: claims.email.trim().toLowerCase() };
}

export async function authenticateRequest(request, config, fetchImpl = fetch) {
  const token = request.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    return await verifyAccessToken(token, config, fetchImpl);
  } catch {
    return null;
  }
}
