import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InviteManagement } from './InviteManagement';

const HOMESERVER = 'x8mmbr5hgsitzp7cigkfewmpqx8j5c9ot4kxe1sfniaeqgys9q6o';
const INVITE = 'AAAA-BBBB';
const EXPECTED_URL = `pubkyauth://direct_signup?hs=${HOMESERVER}&st=${INVITE}`;

const generate = () => vi.fn().mockResolvedValue(INVITE);

async function create() {
  fireEvent.click(screen.getByTestId('invite-create'));
  return screen.findByTestId('invite-created');
}

describe('InviteManagement generation failure', () => {
  it('renders an inline destructive alert with the error and a retry hint', () => {
    render(<InviteManagement onGenerate={generate()} generateError="Request failed (502)" />);
    const alert = screen.getByTestId('invite-generate-error');
    expect(alert.textContent).toContain('Could not create an invite');
    expect(alert.textContent).toContain('Request failed (502)');
    expect(alert.textContent).toContain('try again');
    expect(alert.textContent).toContain('No code was created');
  });

  it('no alert without an error, and nothing created yet', () => {
    render(<InviteManagement onGenerate={generate()} generateError={null} />);
    expect(screen.queryByTestId('invite-generate-error')).toBeNull();
    expect(screen.queryByTestId('invite-created')).toBeNull();
  });

  it('shows nothing when creating fails', async () => {
    const onGenerate = vi.fn().mockRejectedValue(new Error('nope'));
    render(<InviteManagement onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId('invite-create'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalled());
    expect(screen.queryByTestId('invite-created')).toBeNull();
  });
});

describe('InviteManagement limits', () => {
  it('creates with the default limits when none are set, and says so', async () => {
    const onGenerate = generate();
    render(<InviteManagement onGenerate={onGenerate} />);
    await create();
    expect(onGenerate).toHaveBeenCalledWith({});
    expect(screen.getByTestId('invite-limits-summary').textContent).toContain("the homeserver's defaults");
  });

  it('says where the new code can be found again only when the page lists the codes', async () => {
    const { rerender } = render(<InviteManagement onGenerate={generate()} />);
    await create();
    expect(screen.getByTestId('invite-limits-summary').textContent).toContain('shown only now');
    rerender(<InviteManagement onGenerate={generate()} codesListed />);
    expect(screen.getByTestId('invite-limits-summary').textContent).toContain('listed under Invite codes below');
  });

  it('sends the filled-in limits and lists them with the new code', async () => {
    const onGenerate = generate();
    render(<InviteManagement onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId('invite-limits-toggle'));
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Writable paths'), { target: { value: '/pub/site/' } });
    await create();
    expect(onGenerate).toHaveBeenCalledWith({ storage_quota_mb: 500, allowed_write_paths: ['/pub/site/'] });
    const summary = screen.getByTestId('invite-limits-summary').textContent;
    expect(summary).toContain('Storage: 500 MB');
    expect(summary).toContain('Writable paths: /pub/site/');
    expect(screen.getByTestId('invite-created-code').textContent).toBe(INVITE);
  });

  it("shows the homeserver's defaults in the empty fields when they are known", async () => {
    const { rerender } = render(<InviteManagement onGenerate={generate()} />);
    fireEvent.click(screen.getByTestId('invite-limits-toggle'));
    expect((screen.getByLabelText('Storage (MB)') as HTMLInputElement).placeholder).toBe('homeserver default');
    rerender(
      <InviteManagement onGenerate={generate()} homeserverDefaults={{ storage_quota_mb: 500, rate_read: '10mb/s' }} />,
    );
    const placeholder = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).placeholder;
    expect(placeholder('Storage (MB)')).toBe('500 (homeserver default)');
    expect(placeholder('Download rate')).toBe('10mb/s (homeserver default)');
    expect(placeholder('Upload rate')).toBe('unlimited (homeserver default)');
    expect(placeholder('Download burst')).toBe('same as rate (homeserver default)');
    expect(placeholder('Writable paths')).toBe('anywhere (homeserver default)');
  });

  it('ignores the limits while they are hidden', async () => {
    const onGenerate = generate();
    render(<InviteManagement onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId('invite-limits-toggle'));
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('invite-limits-toggle'));
    await create();
    expect(onGenerate).toHaveBeenCalledWith({});
  });

  it('explains an unreadable limit without creating anything', async () => {
    const onGenerate = generate();
    render(<InviteManagement onGenerate={onGenerate} />);
    fireEvent.click(screen.getByTestId('invite-limits-toggle'));
    fireEvent.change(screen.getByLabelText('Storage (MB)'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByTestId('invite-create'));
    expect((await screen.findByTestId('invite-limits-error')).textContent).toContain('whole number of MB');
    expect(onGenerate).not.toHaveBeenCalled();
  });
});

describe('InviteManagement new invite panel', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  // Pubky Ring reads the intent, not just the params: `signup` is the relayed
  // cookie flow, so an invite must go out as `direct_signup`.
  it('encodes the invite as a direct_signup deeplink, shown and copied verbatim', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<InviteManagement onGenerate={generate()} homeserverPubkey={HOMESERVER} />);
    await create();
    expect(screen.getByText(EXPECTED_URL)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Copy invite URL'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXPECTED_URL));
  });

  it('can be dismissed', async () => {
    render(<InviteManagement onGenerate={generate()} homeserverPubkey={HOMESERVER} />);
    await create();
    fireEvent.click(screen.getByLabelText('Done with this invite'));
    expect(screen.queryByTestId('invite-created')).toBeNull();
  });

  it('explains the pubkyauth link needs Pubky Ring and links to pubkyring.app', async () => {
    render(<InviteManagement onGenerate={generate()} homeserverPubkey={HOMESERVER} />);
    await create();
    expect(screen.getByText(/only opens on a device with Pubky Ring installed/)).toBeTruthy();
    expect(screen.getByText(/Don't have Pubky Ring yet\?/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'pubkyring.app' }).getAttribute('href')).toBe('https://pubkyring.app/');
  });

  const watchProps = (total: number, unused: number, onRefreshStats: () => void, onGenerate = generate()) => ({
    onGenerate,
    homeserverPubkey: HOMESERVER,
    signupCodesTotal: total,
    signupCodesUnused: unused,
    onRefreshStats,
  });

  it('polls the stats only while a new invite is shown, and stops once a signup lands', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshStats = vi.fn();
      const onGenerate = generate();
      const view = render(<InviteManagement {...watchProps(1, 1, onRefreshStats, onGenerate)} />);

      await vi.advanceTimersByTimeAsync(7000);
      expect(onRefreshStats).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-create'));
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByTestId('invite-created')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(7000);
      expect(onRefreshStats).toHaveBeenCalled();

      // A signup is the used count going up (total 1 - unused 0).
      const callsBeforeSignup = onRefreshStats.mock.calls.length;
      view.rerender(<InviteManagement {...watchProps(1, 0, onRefreshStats, onGenerate)} />);

      expect(screen.getByTestId('invite-signup-seen')).toBeTruthy();
      expect(screen.getByText('Someone just joined')).toBeTruthy();
      // The code cannot be attributed, so its QR and link stay usable.
      expect(screen.getByText(EXPECTED_URL)).toBeTruthy();

      await vi.advanceTimersByTimeAsync(7000);
      expect(onRefreshStats.mock.calls.length).toBe(callsBeforeSignup);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a signup while no new invite is shown', async () => {
    const onRefreshStats = vi.fn();
    const onGenerate = generate();
    const view = render(<InviteManagement {...watchProps(1, 1, onRefreshStats, onGenerate)} />);
    view.rerender(<InviteManagement {...watchProps(1, 0, onRefreshStats, onGenerate)} />);
    await create();
    expect(screen.queryByTestId('invite-signup-seen')).toBeNull();
  });

  it('stops polling an unattended invite after the watch window', async () => {
    vi.useFakeTimers();
    try {
      const onRefreshStats = vi.fn();
      render(<InviteManagement {...watchProps(1, 1, onRefreshStats)} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId('invite-create'));
        await vi.advanceTimersByTimeAsync(10);
      });

      await vi.advanceTimersByTimeAsync(60_000);
      const callsInFirstMinute = onRefreshStats.mock.calls.length;
      expect(callsInFirstMinute).toBeGreaterThan(10);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const settled = onRefreshStats.mock.calls.length;
      expect(settled).toBeLessThan(callsInFirstMinute * 6);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onRefreshStats.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
