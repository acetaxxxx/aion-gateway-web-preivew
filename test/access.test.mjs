import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessToken } from '../src/access.mjs';

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('validates Access JWT signature, issuer, audience, and expiry', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  const config = { accessTeamDomain: 'team-test.cloudflareaccess.com', accessAudience: 'expected-aud' };
  const now = Math.floor(Date.now() / 1000);
  const header = encoded({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const claims = encoded({
    aud: ['expected-aud'],
    iss: `https://${config.accessTeamDomain}`,
    email: 'Viewer@Example.com',
    exp: now + 120,
    nbf: now - 10,
  });
  const signedContent = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signedContent), privateKey).toString('base64url');
  const token = `${signedContent}.${signature}`;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) });

  assert.deepEqual(await verifyAccessToken(token, config, fetchImpl), { email: 'viewer@example.com' });
  await assert.rejects(
    verifyAccessToken(token, { ...config, accessAudience: 'wrong-aud' }, fetchImpl),
    /audience mismatch/,
  );
  const expiredClaims = encoded({
    aud: ['expected-aud'],
    iss: `https://${config.accessTeamDomain}`,
    email: 'viewer@example.com',
    exp: now - 120,
  });
  const expiredContent = `${header}.${expiredClaims}`;
  const expiredSignature = sign('RSA-SHA256', Buffer.from(expiredContent), privateKey).toString('base64url');
  await assert.rejects(
    verifyAccessToken(`${expiredContent}.${expiredSignature}`, config, fetchImpl),
    /expired/,
  );
  const wrongIssuerClaims = encoded({
    aud: ['expected-aud'],
    iss: 'https://other.cloudflareaccess.com',
    email: 'viewer@example.com',
    exp: now + 120,
  });
  const wrongIssuerContent = `${header}.${wrongIssuerClaims}`;
  const wrongIssuerSignature = sign('RSA-SHA256', Buffer.from(wrongIssuerContent), privateKey).toString('base64url');
  await assert.rejects(
    verifyAccessToken(`${wrongIssuerContent}.${wrongIssuerSignature}`, config, fetchImpl),
    /issuer mismatch/,
  );
  await assert.rejects(
    verifyAccessToken(`${header}.${claims}.invalid`, config, fetchImpl),
    /Invalid Access token signature/,
  );
});
