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

  return {
    port: Number(env.PORT ?? 3000),
    previewScanRoot: required('PREVIEW_SCAN_ROOT', env.PREVIEW_SCAN_ROOT),
    dataDir: required('GATEWAY_DATA_DIR', env.GATEWAY_DATA_DIR),
    accessTeamDomain: teamDomain,
    accessAudience: required('CF_ACCESS_AUDIENCE', env.CF_ACCESS_AUDIENCE),
    adminEmails: new Set(adminEmails),
  };
}
