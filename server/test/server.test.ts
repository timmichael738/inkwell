import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { TEXT_KEY } from '../../shared/types.js';
import { buildApp } from '../src/app.js';
import { COMPACT_AFTER, Store } from '../src/store.js';

let store: Store;
let app: FastifyInstance;
let base: string;
const providers: WebsocketProvider[] = [];

const waitFor = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** A real Yjs client, exactly like a browser tab, speaking the y-websocket protocol. */
async function client(docId: string, name = 'tester') {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(base.replace('http', 'ws') + '/ws', docId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  provider.awareness.setLocalStateField('user', {
    name,
    color: '#2a78d6',
    colorLight: '#2a78d633',
  });
  providers.push(provider);
  await waitFor(() => provider.synced);
  return { doc, provider, text: doc.getText(TEXT_KEY) };
}

beforeEach(async () => {
  store = new Store();
  app = await buildApp({ store, logger: false, roomIdleMs: 50 });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  providers.splice(0).forEach((p) => p.destroy());
  await app.close();
  store.close();
});

const createDoc = async (title = 'Notes') =>
  (await app.inject({ method: 'POST', url: '/api/docs', payload: { title } })).json() as {
    id: string;
  };

describe('real-time sync', () => {
  it('converges concurrent edits from two clients', async () => {
    const { id } = await createDoc();
    const a = await client(id, 'Ada');
    const b = await client(id, 'Grace');

    a.text.insert(0, 'Hello');
    b.text.insert(0, 'World ');
    await waitFor(() => a.text.length === 11 && b.text.length === 11);
    expect(a.text.toString()).toBe(b.text.toString());
  });

  it('shares presence and removes it when a client leaves', async () => {
    const { id } = await createDoc();
    const a = await client(id, 'Ada');
    const b = await client(id, 'Grace');
    const names = () =>
      [...a.provider.awareness.getStates().values()].map(
        (s) => (s as { user?: { name: string } }).user?.name,
      );
    await waitFor(() => names().includes('Grace'));

    b.provider.destroy();
    await waitFor(() => !names().includes('Grace'));
  });

  it('persists edits so a late joiner (and a restart) gets the full document', async () => {
    const { id } = await createDoc();
    const a = await client(id);
    a.text.insert(0, '# Plan\n- ship it');
    await waitFor(() => store.loadState(id) !== null);
    a.provider.destroy();
    await waitFor(() => app.rooms.size === 0); // room unloaded after idle timeout

    const later = await client(id);
    await waitFor(() => later.text.toString() === '# Plan\n- ship it');
  });

  it('rejects sockets for unknown documents', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/doesnotexist');
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4404);
  });
});

describe('versions', () => {
  it('saves a named version and restores it live for connected clients', async () => {
    const { id } = await createDoc();
    const a = await client(id);
    a.text.insert(0, 'First draft');
    await waitFor(() => store.loadState(id) !== null);

    const saved = await app.inject({
      method: 'POST',
      url: `/api/docs/${id}/versions`,
      payload: { name: 'Draft 1' },
    });
    expect(saved.json()).toMatchObject({ name: 'Draft 1', preview: 'First draft', characters: 11 });

    a.text.delete(0, a.text.length);
    a.text.insert(0, 'Rewritten completely');
    await waitFor(() => app.rooms.peek(id)!.text.toString() === 'Rewritten completely');

    const restore = await app.inject({
      method: 'POST',
      url: `/api/docs/${id}/versions/${saved.json().id}/restore`,
    });
    expect(restore.statusCode).toBe(204);
    await waitFor(() => a.text.toString() === 'First draft');
  });

  it('works when nobody has the document open', async () => {
    const { id } = await createDoc();
    const res = await app.inject({
      method: 'POST',
      url: `/api/docs/${id}/versions`,
      payload: { name: 'Empty' },
    });
    expect(res.json().characters).toBe(0);
    expect((await app.inject({ url: `/api/docs/${id}/versions` })).json().versions).toHaveLength(1);
  });
});

describe('store', () => {
  it('compacts the update log without changing the document', () => {
    const doc = store.createDoc('t');
    const ydoc = new Y.Doc();
    ydoc.on('update', (u: Uint8Array) => store.appendUpdate(doc.id, u));
    for (let i = 0; i < COMPACT_AFTER + 5; i++) ydoc.getText(TEXT_KEY).insert(i, 'x');
    expect(store.updateCount(doc.id)).toBeLessThan(10);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, store.loadState(doc.id)!);
    expect(restored.getText(TEXT_KEY).toString()).toBe('x'.repeat(COMPACT_AFTER + 5));
  });
});

describe('REST API', () => {
  it('creates, lists, renames and deletes documents', async () => {
    const { id } = await createDoc('Spec');
    expect((await app.inject({ url: '/api/docs' })).json().docs).toHaveLength(1);
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/docs/${id}`,
      payload: { title: 'RFC' },
    });
    expect(renamed.json().title).toBe('RFC');
    expect((await app.inject({ method: 'DELETE', url: `/api/docs/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/docs/${id}` })).statusCode).toBe(404);
  });

  it('validates input', async () => {
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/docs/abc123', payload: { title: '' } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/api/docs/bad!id' })).statusCode).toBe(400);
  });
});
