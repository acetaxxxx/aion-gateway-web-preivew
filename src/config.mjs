function required(name, value) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function loadConfig(env = process.env) {
  const teamDomain = required('CF_ACCESS_TEAM_DOMAIN', env.CF_ACCESS_TEAM_DOMAIN)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const adminEmails = (env.GATEWAY_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  const mcpToken = env.GATEWAY_MCP_TOKEN?.trim() ?? '';
  let publicUrl;
  if (mcpToken) {
    if (mcpToken.length < 32) throw new Error('GATEWAY_MCP_TOKEN must contain at least 32 characters');
    const parsed = new URL(required('GATEWAY_PUBLIC_URL', env.GATEWAY_PUBLIC_URL));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('GATEWAY_PUBLIC_URL must be an HTTPS origin');
    }
    publicUrl = parsed.origin;
  }

  return {
    port: Number(env.PORT ?? 3000),
    previewScanRoot: required('PREVIEW_SCAN_ROOT', env.PREVIEW_SCAN_ROOT),
    dataDir: required('GATEWAY_DATA_DIR', env.GATEWAY_DATA_DIR),
    accessTeamDomain: teamDomain,
    accessAudience: required('CF_ACCESS_AUDIENCE', env.CF_ACCESS_AUDIENCE),
    adminEmails: new Set(adminEmails),
    mcpToken,
    publicUrl,
    agentWorkspaceRoot: env.AION_WORKSPACE_ROOT ?? '/data/conversations/users',
  };
}
