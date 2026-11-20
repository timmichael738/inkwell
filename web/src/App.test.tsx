// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { CURSOR_COLORS, initials, loadIdentity, randomIdentity } from './identity';

vi.mock('./components/Editor', () => ({
  Editor: ({ docId }: { docId: string }) => <div>editor for {docId}</div>,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  history.replaceState(null, '', '/');
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('identity', () => {
  it('builds a friendly name and a palette color', () => {
    const id = randomIdentity(() => 0);
    expect(id.name).toBe('Brave Otter');
    expect(id.color).toBe(CURSOR_COLORS[0].color);
  });

  it('persists the identity between visits', () => {
    expect(loadIdentity()).toEqual(loadIdentity());
  });

  it('derives initials', () => {
    expect(initials('Sunny Heron')).toBe('SH');
  });
});

describe('document list', () => {
  it('lists documents and opens one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          json({ docs: [{ id: 'abc123xyz', title: 'Design doc', createdAt: 1, updatedAt: 2 }] }),
        ),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('link', { name: /Design doc/ }));
    expect(location.pathname).toBe('/d/abc123xyz');
    expect(screen.getByText('editor for abc123xyz')).toBeInTheDocument();
  });

  it('creates a new document and navigates to it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ docs: [] }))
      .mockResolvedValueOnce(
        json({ id: 'new123doc', title: 'Untitled', createdAt: 1, updatedAt: 1 }, 201),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New document' }));
    expect(await screen.findByText('editor for new123doc')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]![1].method).toBe('POST');
  });
});
