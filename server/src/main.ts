import { buildApp } from './app.js';
import { Store } from './store.js';

const store = new Store(process.env.DATABASE_PATH ?? 'data/inkwell.db');
const app = await buildApp({ store });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 4100) });
