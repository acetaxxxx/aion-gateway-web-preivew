import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { PreviewRegistry } from './registry.mjs';
import { createGatewayServer } from './server.mjs';

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const registry = new PreviewRegistry(join(config.dataDir, 'previews.json'));
const server = createGatewayServer({ config, registry });

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Workspace Gateway listening on port ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
