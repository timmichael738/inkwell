import { useEffect, useState } from 'react';
import type { DocSummary } from '../../shared/types';
import { api, navigate } from './api';
import { Editor } from './components/Editor';

function usePath() {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export default function App() {
  const path = usePath();
  const match = path.match(/^\/d\/([\w-]+)$/);
  return match ? <Editor key={match[1]} docId={match[1]!} /> : <DocList />;
}

function DocList() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ docs: DocSummary[] }>('/api/docs')
      .then((r) => setDocs(r.docs))
      .catch((e: Error) => setError(e.message));
  }, []);

  const create = async () => {
    try {
      const doc = await api<DocSummary>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled' }),
      });
      navigate(`/d/${doc.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (doc: DocSummary) => {
    if (!confirm(`Delete "${doc.title}" for everyone?`)) return;
    await api(`/api/docs/${doc.id}`, { method: 'DELETE' });
    setDocs((d) => d?.filter((x) => x.id !== doc.id) ?? null);
  };

  return (
    <main className="home">
      <header className="home-header">
        <h1>
          <span aria-hidden="true">✒</span> Inkwell
        </h1>
        <p className="muted">Real-time collaborative Markdown. Share a link and write together.</p>
        <button type="button" className="primary" onClick={() => void create()}>
          New document
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {docs?.length === 0 && (
        <p className="muted center">No documents yet. Create one to get started.</p>
      )}
      <ul className="doc-list">
        {docs?.map((doc) => (
          <li key={doc.id}>
            <a
              href={`/d/${doc.id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/d/${doc.id}`);
              }}
            >
              <strong>{doc.title}</strong>
              <span className="muted">Edited {new Date(doc.updatedAt).toLocaleString()}</span>
            </a>
            <button
              type="button"
              className="ghost"
              aria-label={`Delete ${doc.title}`}
              onClick={() => void remove(doc)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
