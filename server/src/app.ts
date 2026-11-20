import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type * as Y from 'yjs';
import { z } from 'zod';
import { createDocSchema, createVersionSchema, renameDocSchema } from '../../shared/types.js';
import { MAX_MESSAGE_BYTES, RoomManager } from './rooms.js';
import type { Store } from './store.js';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const docParams = z.object({ id: z.string().regex(/^[\w-]{6,32}$/) });
const versionParams = docParams.extend({ versionId: z.coerce.number().int().positive() });

export interface AppOptions {
  store: Store;
  logger?: FastifyServerOptions['logger'];
  roomIdleMs?: number;
}

export async function buildApp({ store, logger = true, roomIdleMs }: AppOptions) {
  const app = Fastify({ logger });
  const rooms = new RoomManager(store, roomIdleMs);
  app.decorate('rooms', rooms);
  app.addHook('onClose', async () => rooms.closeAll());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', issues: z.flattenError(error).fieldErrors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  const findDoc = (params: unknown) => {
    const { id } = docParams.parse(params);
    return store.getDoc(id);
  };

  /** Runs `fn` against the live room, or a temporary one if nobody has the document open. */
  const withRoom = <T>(id: string, fn: (doc: Y.Doc, replace: (text: string) => void) => T): T => {
    const live = rooms.peek(id);
    if (live) return fn(live.doc, (t) => live.replaceText(t));
    const room = rooms.get(id);
    try {
      return fn(room.doc, (t) => room.replaceText(t));
    } finally {
      rooms.unload(id);
    }
  };

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/docs', async () => ({ docs: store.listDocs() }));

  app.post('/api/docs', async (request, reply) => {
    const { title } = createDocSchema.parse(request.body ?? {});
    return reply.code(201).send(store.createDoc(title));
  });

  app.get(
    '/api/docs/:id',
    async (request, reply) =>
      findDoc(request.params) ?? reply.code(404).send({ error: 'Not found' }),
  );

  app.patch('/api/docs/:id', async (request, reply) => {
    const { id } = docParams.parse(request.params);
    const { title } = renameDocSchema.parse(request.body);
    return store.renameDoc(id, title)
      ? store.getDoc(id)
      : reply.code(404).send({ error: 'Not found' });
  });

  app.delete('/api/docs/:id', async (request, reply) => {
    const { id } = docParams.parse(request.params);
    rooms.peek(id)?.destroy();
    rooms.unload(id);
    return store.deleteDoc(id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'Not found' });
  });

  app.get('/api/docs/:id/versions', async (request, reply) => {
    const doc = findDoc(request.params);
    return doc
      ? { versions: store.listVersions(doc.id) }
      : reply.code(404).send({ error: 'Not found' });
  });

  app.post('/api/docs/:id/versions', async (request, reply) => {
    const doc = findDoc(request.params);
    if (!doc) return reply.code(404).send({ error: 'Not found' });
    const { name } = createVersionSchema.parse(request.body);
    return reply.code(201).send(withRoom(doc.id, (ydoc) => store.saveVersion(doc.id, name, ydoc)));
  });

  app.post('/api/docs/:id/versions/:versionId/restore', async (request, reply) => {
    const { id, versionId } = versionParams.parse(request.params);
    const text = store.versionText(id, versionId);
    if (text === null) return reply.code(404).send({ error: 'Version not found' });
    withRoom(id, (_doc, replace) => replace(text));
    return reply.code(204).send();
  });

  app.get('/ws/:id', { websocket: true }, (socket, request) => {
    const doc = findDoc(request.params);
    if (!doc) {
      socket.close(4404, 'Document not found');
      return;
    }
    rooms.connect(doc.id, socket);
  });

  if (existsSync(new URL('../../web/assets/', import.meta.url))) {
    await app.register(fastifyStatic, { root: WEB_DIR });
    app.setNotFoundHandler((request, reply) =>
      request.method === 'GET' && !request.url.startsWith('/api/')
        ? reply.sendFile('index.html')
        : reply.code(404).send({ error: 'Not Found' }),
    );
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    rooms: RoomManager;
  }
}
