import { markdown } from '@codemirror/lang-markdown';
import { EditorView, basicSetup } from 'codemirror';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { yCollab } from 'y-codemirror.next';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { TEXT_KEY, type DocSummary } from '../../../shared/types';
import { api, navigate, wsUrl } from '../api';
import { initials, loadIdentity, saveIdentity, type Identity } from '../identity';
import { History } from './History';

type Status = 'connecting' | 'connected' | 'disconnected';

interface Peer extends Identity {
  clientId: number;
  self: boolean;
}

export function Editor({ docId }: { docId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<DocSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const [preview, setPreview] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState('');

  // One Y.Doc + provider per document; everything else binds to these.
  const { ydoc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(wsUrl(), docId, ydoc, { connect: false });
    return { ydoc, provider };
  }, [docId]);

  useEffect(() => {
    api<DocSummary>(`/api/docs/${docId}`)
      .then(setMeta)
      .catch(() => setMissing(true));
  }, [docId]);

  useEffect(() => {
    const ytext = ydoc.getText(TEXT_KEY);
    const undoManager = new Y.UndoManager(ytext);
    const view = new EditorView({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness, { undoManager }),
        EditorView.contentAttributes.of({ 'aria-label': 'Document text' }),
      ],
      parent: host.current!,
    });

    const onStatus = ({ status }: { status: Status }) => setStatus(status);
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        const user = (state as { user?: Identity }).user;
        if (user) list.push({ ...user, clientId, self: clientId === ydoc.clientID });
      });
      setPeers(list.sort((a, b) => Number(b.self) - Number(a.self)));
    };
    const onText = () => setText(ytext.toString());

    provider.on('status', onStatus);
    provider.awareness.on('change', onAwareness);
    ytext.observe(onText);
    provider.connect();

    return () => {
      ytext.unobserve(onText);
      provider.awareness.off('change', onAwareness);
      provider.off('status', onStatus);
      view.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  }, [ydoc, provider]);

  useEffect(() => {
    provider.awareness.setLocalStateField('user', identity);
    saveIdentity(identity);
  }, [provider, identity]);

  const html = useMemo(
    () => (preview ? DOMPurify.sanitize(marked.parse(text, { async: false })) : ''),
    [preview, text],
  );

  if (missing) {
    return (
      <div className="center">
        <h1>Document not found</h1>
        <button type="button" onClick={() => navigate('/')}>
          Back to documents
        </button>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="toolbar">
        <button
          type="button"
          className="ghost"
          onClick={() => navigate('/')}
          aria-label="All documents"
        >
          ←
        </button>
        <input
          className="title"
          aria-label="Document title"
          key={meta?.title}
          defaultValue={meta?.title ?? ''}
          onBlur={(e) => {
            const title = e.target.value.trim();
            if (title && title !== meta?.title) {
              void api<DocSummary>(`/api/docs/${docId}`, {
                method: 'PATCH',
                body: JSON.stringify({ title }),
              }).then(setMeta);
            }
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className={`status status-${status}`} role="status">
          <span aria-hidden="true">●</span>{' '}
          {status === 'connected'
            ? 'Live'
            : status === 'connecting'
              ? 'Connecting…'
              : 'Offline, edits will sync'}
        </span>
        <span className="spacer" />
        <ul className="peers" aria-label={`${peers.length} people here`}>
          {peers.map((p) => (
            <li
              key={p.clientId}
              title={p.self ? `${p.name} (you)` : p.name}
              style={{ background: p.color }}
            >
              {initials(p.name)}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const name = prompt('Your display name', identity.name)?.trim();
            if (name) setIdentity({ ...identity, name: name.slice(0, 40) });
          }}
        >
          {identity.name}
        </button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          Preview
        </button>
        <button type="button" aria-pressed={historyOpen} onClick={() => setHistoryOpen((h) => !h)}>
          History
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void navigator.clipboard?.writeText(location.href)}
          title="Anyone with the link can edit"
        >
          Copy link
        </button>
      </header>

      <div className={`workspace ${preview ? 'split' : ''}`}>
        <div className="cm-host" ref={host} />
        {preview && (
          <article
            className="preview"
            aria-label="Markdown preview"
            // Sanitized with DOMPurify: collaborators can't inject scripts into each other's browsers.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {historyOpen && <History docId={docId} onClose={() => setHistoryOpen(false)} />}
      </div>
    </div>
  );
}
