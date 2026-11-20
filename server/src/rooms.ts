import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { TEXT_KEY } from '../../shared/types.js';
import type { Store } from './store.js';

/** Message types of the standard y-websocket protocol, so any Yjs client can connect. */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

const OPEN = 1;
/** Oversized frames are rejected by the WebSocket server before they reach the document. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * One live document: an authoritative Y.Doc, the presence (awareness) of everyone connected,
 * and the sockets to fan updates out to. Every update is persisted as it arrives.
 */
export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** socket → awareness client ids it controls, so we can clear them on disconnect. */
  readonly conns = new Map<WebSocket, Set<number>>();

  constructor(
    readonly id: string,
    private readonly store: Store,
  ) {
    const state = store.loadState(id);
    if (state) Y.applyUpdate(this.doc, state, 'load');
    this.awareness.setLocalState(null); // the server itself has no cursor

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'load') store.appendUpdate(id, update);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (origin instanceof Object && this.conns.has(origin as WebSocket)) {
          const owned = this.conns.get(origin as WebSocket)!;
          added.forEach((c) => owned.add(c));
          removed.forEach((c) => owned.delete(c));
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  get text(): Y.Text {
    return this.doc.getText(TEXT_KEY);
  }

  join(socket: WebSocket): void {
    this.conns.set(socket, new Set());

    socket.on('message', (raw: Buffer) => {
      try {
        this.handleMessage(socket, new Uint8Array(raw));
      } catch {
        socket.close(1003, 'Malformed message');
      }
    });
    socket.on('close', () => this.leave(socket));

    // Start the sync handshake: send our state vector, and current presence.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    socket.send(encoding.toUint8Array(encoder));

    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aw,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, states),
      );
      socket.send(encoding.toUint8Array(aw));
    }
  }

  private handleMessage(socket: WebSocket, message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, socket);
      if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        socket,
      );
    }
  }

  leave(socket: WebSocket): void {
    const owned = this.conns.get(socket);
    if (!owned) return;
    this.conns.delete(socket);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...owned], null);
  }

  private broadcast(message: Uint8Array): void {
    for (const socket of this.conns.keys()) {
      if (socket.readyState === OPEN) socket.send(message);
    }
  }

  /**
   * Restores text from a saved version as a *new edit*, not by rewriting history: collaborators
   * see the change live and the restore itself can be undone or versioned.
   */
  replaceText(content: string): void {
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    }, 'restore');
  }

  destroy(): void {
    for (const socket of this.conns.keys()) socket.close(1001, 'Room closed');
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/** Creates rooms on demand and unloads them a little after the last person leaves. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: Store,
    private readonly idleMs = 30_000,
  ) {}

  get(id: string): Room {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id, this.store);
      this.rooms.set(id, room);
    }
    return room;
  }

  /** Returns the live room if loaded, otherwise a temporary one (caller must not keep it). */
  peek(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  connect(id: string, socket: WebSocket): Room {
    const room = this.get(id);
    room.join(socket);
    socket.on('close', () => {
      if (room.conns.size === 0) {
        this.timers.set(id, setTimeout(() => this.unload(id), this.idleMs).unref());
      }
    });
    return room;
  }

  unload(id: string): void {
    const room = this.rooms.get(id);
    if (!room || room.conns.size > 0) return;
    room.destroy();
    this.rooms.delete(id);
    this.timers.delete(id);
  }

  get size(): number {
    return this.rooms.size;
  }

  closeAll(): void {
    for (const id of [...this.rooms.keys()]) {
      clearTimeout(this.timers.get(id));
      this.rooms.get(id)!.destroy();
    }
    this.rooms.clear();
  }
}
