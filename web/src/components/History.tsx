import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Version } from '../../../shared/types';
import { api } from '../api';

const timeAgo = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return rtf.format(-s, 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86_400), 'day');
};

export function History({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ versions: Version[] }>(`/api/docs/${docId}/versions`)
        .then((r) => setVersions(r.versions))
        .catch((e: Error) => setError(e.message)),
    [docId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    try {
      await api(`/api/docs/${docId}/versions`, { method: 'POST', body: JSON.stringify({ name }) });
      form.reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const restore = async (v: Version) => {
    if (!confirm(`Restore "${v.name}"? Everyone editing will see the document change.`)) return;
    try {
      await api(`/api/docs/${docId}/versions/${v.id}/restore`, { method: 'POST' });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <aside className="history" aria-label="Version history">
      <header>
        <h2>History</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close history">
          ×
        </button>
      </header>
      <form onSubmit={save} className="save-version">
        <input
          name="name"
          placeholder="Name this version…"
          aria-label="Version name"
          maxLength={80}
        />
        <button type="submit">Save</button>
      </form>
      {error && <p className="error">{error}</p>}
      {versions?.length === 0 && <p className="muted">No saved versions yet.</p>}
      <ol className="versions">
        {versions?.map((v) => (
          <li key={v.id}>
            <div className="version-head">
              <strong>{v.name}</strong>
              <span className="muted">{timeAgo(v.createdAt)}</span>
            </div>
            <p className="muted preview-text">{v.preview || '(empty)'}</p>
            <button type="button" onClick={() => void restore(v)}>
              Restore
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
