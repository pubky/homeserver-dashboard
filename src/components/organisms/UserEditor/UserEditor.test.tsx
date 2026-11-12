import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserEditor } from './UserEditor';

const ALICE = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let quota = { effective: { storage_quota_mb: 1024 as number | 'unlimited' }, overrides: {} as Record<string, unknown> };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  quota = { effective: { storage_quota_mb: 1024 }, overrides: {} };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      quota = { effective: { ...quota.effective, ...patch }, overrides: { ...quota.overrides, ...patch } };
      return new Response(null, { status: 200 });
    }
    if (String(input).includes(ALICE)) return json(quota);
    return new Response('Not Found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = vi.fn().mockResolvedValue(undefined);

async function lookUp(pubky: string) {
  fireEvent.change(screen.getByLabelText('User pubky'), { target: { value: pubky } });
  fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
}

describe('UserEditor', () => {
  it('looks a user up, accepting the pubky prefix, and shows defaults as placeholders', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(`pubky${ALICE}`);
    await screen.findByTestId('user-editor-result');
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/admin/users/${ALICE}/quota`);
    const storage = screen.getByLabelText('Storage (MB)') as HTMLInputElement;
    expect(storage.value).toBe('');
    expect(storage.placeholder).toBe('1024');
  });

  it('saves only what changed and shows the field as custom', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-editor-result');
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowance' }));
    await screen.findByText('Allowance saved.');
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ storage_quota_mb: 2048 });
    expect((screen.getByLabelText('Storage (MB)') as HTMLInputElement).value).toBe('2048');
    expect(screen.getByText('custom')).toBeTruthy();
  });

  it('explains an unparseable field without calling the homeserver', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-editor-result');
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowance' }));
    expect((await screen.findByTestId('user-editor-error')).textContent).toContain('whole number of MB');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('says when there is no such user', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp('8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo');
    expect((await screen.findByTestId('user-editor-error')).textContent).toContain('no user with that pubky');
    expect(screen.queryByTestId('user-editor-result')).toBeNull();
  });

  it('says when the pubky is not one', async () => {
    fetchMock.mockResolvedValue(new Response('Invalid PublicKey length', { status: 400 }));
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp('nonsense');
    expect((await screen.findByTestId('user-editor-error')).textContent).toContain('not a valid pubky');
  });

  it('does not let the key be changed while it is being looked up', async () => {
    let answer: (response: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    expect((screen.getByLabelText('User pubky') as HTMLInputElement).disabled).toBe(true);
    answer(json(quota));
    await screen.findByTestId('user-editor-result');
    expect((screen.getByLabelText('User pubky') as HTMLInputElement).disabled).toBe(false);
  });

  it('does not claim a save it could not read back', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-editor-result');
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PATCH' ? new Response(null, { status: 200 }) : new Response('db down', { status: 500 }),
    );
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allowance' }));
    expect((await screen.findByTestId('user-editor-error')).textContent).toContain('db down');
    expect(screen.queryByTestId('user-editor-notice')).toBeNull();
  });

  it('does not know the status on a homeserver that does not report it, and offers both actions', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-access');
    expect(screen.getByTestId('user-access-not-known')).toBeTruthy();
    expect(screen.getByTestId('user-access-unknown')).toBeTruthy();
    expect(screen.getByTestId('user-enable')).toBeTruthy();
    expect(screen.getByTestId('user-disable')).toBeTruthy();
  });

  it('disables and enables through the given handlers, remembering the result', async () => {
    const onDisable = vi.fn().mockResolvedValue(undefined);
    const onEnable = vi.fn().mockRejectedValue(new Error('homeserver said no'));
    render(<UserEditor onDisableUser={onDisable} onEnableUser={onEnable} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-access');
    fireEvent.click(screen.getByTestId('user-disable'));
    await screen.findByText(/User disabled/);
    expect(onDisable).toHaveBeenCalledWith(ALICE);
    expect(screen.getByTestId('user-access-disabled')).toBeTruthy();
    expect(screen.queryByTestId('user-disable')).toBeNull();
    fireEvent.click(screen.getByTestId('user-enable'));
    expect((await screen.findByTestId('user-editor-error')).textContent).toContain('homeserver said no');
    expect(screen.getByTestId('user-access-disabled')).toBeTruthy(); // the failed enable changed nothing
  });

  it('forgets a remembered status when another account is looked up', async () => {
    const BOB = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('Ok', { status: 200 });
      return json(quota);
    });
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-access');
    fireEvent.click(screen.getByTestId('user-disable'));
    await screen.findByTestId('user-access-disabled');
    await lookUp(BOB);
    await waitFor(() => expect(screen.getByTestId('user-access-not-known')).toBeTruthy());
  });

  it('clears the account when the key is removed from the search bar', async () => {
    render(<UserEditor onDisableUser={noop} onEnableUser={noop} />);
    await lookUp(ALICE);
    await screen.findByTestId('user-editor-result');
    fireEvent.change(screen.getByLabelText('User pubky'), { target: { value: '' } });
    expect(screen.queryByTestId('user-editor-result')).toBeNull();
    expect(screen.queryByTestId('user-access')).toBeNull();
    // Typing again shows nothing until the next look-up.
    fireEvent.change(screen.getByLabelText('User pubky'), { target: { value: 'pub' } });
    expect(screen.queryByTestId('user-access')).toBeNull();
  });

  it('with the user routes, reads status and usage from the account and re-reads after an action', async () => {
    let disabled = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        disabled = url.endsWith('/disable');
        return new Response('Ok', { status: 200 });
      }
      if (url.endsWith(`/users/${ALICE}`))
        return json({
          pubky: ALICE,
          created_at: '2026-10-22T10:00:00',
          disabled,
          used_bytes: 30 * 1024 * 1024,
          quota: { effective: { storage_quota_mb: 500 }, overrides: { storage_quota_mb: 500 } },
        });
      return new Response('Not Found', { status: 404 });
    });
    const onDisable = vi.fn(async (pubkey: string) => {
      await fetch(`/api/admin/users/${pubkey}/disable`, { method: 'POST' });
    });
    render(<UserEditor onDisableUser={onDisable} onEnableUser={noop} hasUserRoutes />);
    await lookUp(ALICE);
    await screen.findByTestId('user-access-enabled');
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(`/api/admin/users/${ALICE}`);
    expect(screen.getByTestId('user-usage').textContent).toBe('30 MB of 500 MB (6%)');
    expect(screen.queryByTestId('user-access-unknown')).toBeNull();
    expect((screen.getByLabelText('Storage (MB)') as HTMLInputElement).value).toBe('500');
    fireEvent.click(screen.getByTestId('user-disable'));
    await screen.findByText(/User disabled/);
    expect(screen.getByTestId('user-access-disabled')).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === `/api/admin/users/${ALICE}`)).toHaveLength(2);
  });

  it('opens a user requested from elsewhere', async () => {
    render(<UserEditor openRequest={{ pubkey: ALICE, nonce: 1 }} onDisableUser={noop} onEnableUser={noop} />);
    await screen.findByTestId('user-editor-result');
    await waitFor(() => expect((screen.getByLabelText('User pubky') as HTMLInputElement).value).toBe(ALICE));
  });
});
