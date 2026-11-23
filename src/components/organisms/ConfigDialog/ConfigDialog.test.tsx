import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigDialog } from './ConfigDialog';
import { PlatformProvider } from '@/components/providers/PlatformProvider';

type CloudflareMode = 'connect' | 'token' | 'preview' | 'off';
type JsonResponse = { status?: number; json: Record<string, unknown> };

/** Mutable fake backend for everything the dialog fetches. */
function mockBackend(initial: {
  cloudflareConfig: JsonResponse;
  connect?: Record<string, unknown>;
  preview?: Record<string, unknown>;
  adminInfo?: Record<string, unknown>;
  publicHealth?: Record<string, unknown>;
  /** The homeserver's config as `/api/server-config` answers it; without one the config view has nothing to show. */
  serverConfig?: Record<string, unknown>;
}) {
  const backend = {
    cloudflareConfig: initial.cloudflareConfig,
    connect: initial.connect ?? { supported: true, status: 'idle' },
    preview: initial.preview ?? { enabled: false, instant: { status: 'stopped' }, supported: true },
    adminInfo: initial.adminInfo ?? {},
    publicHealth: initial.publicHealth ?? { ok: true },
    disconnect: {
      status: 200,
      json: {
        ok: true,
        message: "Disconnected. Restart the Pubky Homeserver app from Umbrel (open the app's tile, then Restart).",
      },
    },
    disconnectCalls: 0,
  };
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const respond = (json: unknown, status = 200) =>
      new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('/api/cloudflare-config') && init?.method !== 'POST') {
      return respond(backend.cloudflareConfig.json, backend.cloudflareConfig.status ?? 200);
    }
    if (url.startsWith('/api/cloudflare-connect')) return respond(backend.connect);
    if (url.startsWith('/api/cloudflare-preview')) return respond(backend.preview);
    if (url.startsWith('/api/cloudflare-disconnect')) {
      backend.disconnectCalls++;
      return respond(backend.disconnect.json, backend.disconnect.status);
    }
    if (url.startsWith('/api/admin/info')) return respond(backend.adminInfo);
    if (url.startsWith('/api/public-health')) return respond(backend.publicHealth);
    if (url.startsWith('/api/server-config')) {
      return initial.serverConfig ? respond(initial.serverConfig) : respond({ error: 'not available' }, 404);
    }
    return respond({});
  });
  return backend;
}

const cfConfig = (mode: CloudflareMode, domain: string | null = null): JsonResponse => ({
  json: { domain, mode, configured: mode === 'connect' || mode === 'token', supported: true },
});

function renderDialog() {
  return render(<ConfigDialog open onOpenChange={() => {}} />);
}

describe('ConfigDialog Cloudflare status surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what changing admin_password means for this kind of deployment', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('off'),
      serverConfig: { config: '[admin]\n', checksum: 'sha256:x', mtime: '2026-01-01T00:00:00Z', writable: false },
    });
    const { unmount } = render(
      <PlatformProvider platform="standalone">
        <ConfigDialog open onOpenChange={() => {}} />
      </PlatformProvider>,
    );
    const standalone = (await screen.findByTestId('admin-password-note')).textContent;
    expect(standalone).toContain('restart the homeserver');
    expect(standalone).not.toContain('Do not change');
    unmount();

    render(
      <PlatformProvider platform="umbrel">
        <ConfigDialog open onOpenChange={() => {}} />
      </PlatformProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Config' }));
    expect((await screen.findByTestId('admin-password-note')).textContent).toContain('Do not change');
  });

  it('standalone: the Cloudflare tab and all its setup cards are hidden', async () => {
    mockBackend({ cloudflareConfig: cfConfig('off') });
    render(
      <PlatformProvider platform="standalone">
        <ConfigDialog open onOpenChange={() => {}} />
      </PlatformProvider>,
    );
    // The Config tab still loads; the Cloudflare surface must be entirely absent.
    await waitFor(() => expect(screen.queryByTestId('cf-mode-badge')).toBeNull());
    expect(screen.queryByText('Cloudflare')).toBeNull();
    expect(screen.queryByTestId('cf-connect')).toBeNull();
    expect(screen.queryByTestId('cf-api-token-toggle')).toBeNull();
    expect(screen.queryByTestId('cf-preview')).toBeNull();
  });

  it('mode off: badge says Off, all four setup cards render directly, no disconnect', async () => {
    mockBackend({ cloudflareConfig: cfConfig('off') });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.getByTestId('cf-mode-badge').textContent).toBe('Off');
    expect(screen.getByTestId('cf-connect')).toBeTruthy();
    expect(screen.getByTestId('cf-api-token-toggle')).toBeTruthy();
    expect(screen.getByTestId('cf-preview')).toBeTruthy();
    expect(screen.getByTestId('cf-manual-toggle')).toBeTruthy();
    expect(screen.queryByTestId('cf-switch-method-toggle')).toBeNull();
    expect(screen.queryByTestId('cf-disconnect')).toBeNull();
  });

  it('mode connect: badge, domain, reachability chip and a single disconnect; cards collapsed', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('connect', 'pubky.example.com'),
      connect: { supported: true, status: 'completed', hostname: 'pubky.example.com' },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.getByTestId('cf-mode-badge').textContent).toBe('Connected account');
    expect(screen.getByTestId('cf-status-address').textContent).toBe('pubky.example.com');
    await waitFor(() => expect(screen.getByTestId('cf-status-reachable')).toBeTruthy());
    expect(screen.getAllByTestId('cf-disconnect')).toHaveLength(1);
    // Cards are demoted to the disclosure and assert nothing themselves.
    expect(screen.queryByTestId('cf-connect')).toBeNull();
    expect(screen.queryByTestId('cf-connect-success')).toBeNull();
    fireEvent.click(screen.getByTestId('cf-switch-method-toggle'));
    await waitFor(() => expect(screen.getByTestId('cf-connect')).toBeTruthy());
    // Even though the server reports the connect flow as completed, the card
    // is a pure action again: no second success state, no second disconnect.
    expect(screen.getByTestId('cf-connect-start')).toBeTruthy();
    expect(screen.queryByTestId('cf-connect-success')).toBeNull();
    expect(screen.getAllByTestId('cf-disconnect')).toHaveLength(1);
  });

  it('mode token: badge says API token', async () => {
    mockBackend({ cloudflareConfig: cfConfig('token', 'pubky.example.com') });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.getByTestId('cf-mode-badge').textContent).toBe('API token');
    expect(screen.getByTestId('cf-status-address').textContent).toBe('pubky.example.com');
  });

  it('mode preview: badge says Preview and the address comes from the preview endpoint', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('preview'),
      preview: {
        enabled: true,
        instant: { status: 'stopped' },
        published_url: 'https://random.trycloudflare.com',
        supported: true,
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.getByTestId('cf-mode-badge').textContent).toBe('Preview');
    // Rendered as a clickable link: clean host label, full https href.
    await waitFor(() => expect(screen.getByTestId('cf-status-address').textContent).toBe('random.trycloudflare.com'));
    expect(screen.getByTestId('cf-status-address').getAttribute('href')).toBe('https://random.trycloudflare.com');
    expect(screen.getByTestId('cf-disconnect')).toBeTruthy();
  });

  it('disconnect re-syncs everything: no card can keep claiming connected', async () => {
    const backend = mockBackend({
      cloudflareConfig: cfConfig('connect', 'pubky.example.com'),
      connect: { supported: true, status: 'completed', hostname: 'pubky.example.com' },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-disconnect')).toBeTruthy());
    // Open the disclosure first so a stale card would be visible if it cached.
    fireEvent.click(screen.getByTestId('cf-switch-method-toggle'));
    await waitFor(() => expect(screen.getByTestId('cf-connect')).toBeTruthy());

    fireEvent.click(screen.getByTestId('cf-disconnect'));
    expect(screen.getByTestId('cf-disconnect').textContent).toBe('Confirm?');
    // After the disconnect lands, the server reports mode off everywhere.
    backend.cloudflareConfig = cfConfig('off');
    backend.connect = { supported: true, status: 'idle' };
    fireEvent.click(screen.getByTestId('cf-disconnect'));

    await waitFor(() => expect(screen.getByTestId('cf-mode-badge').textContent).toBe('Off'));
    expect(backend.disconnectCalls).toBe(1);
    expect(screen.queryByTestId('cf-disconnect')).toBeNull();
    expect(screen.queryByTestId('cf-switch-method-toggle')).toBeNull();
    // Cards render directly again as pure actions; the old contradiction
    // (a card claiming "connected" under an Off status) must be impossible.
    await waitFor(() => expect(screen.getByTestId('cf-connect-start')).toBeTruthy());
    expect(screen.queryByTestId('cf-connect-success')).toBeNull();
    expect(screen.queryByText(/account connected/i)).toBeNull();
    const callout = screen.getByTestId('restart-callout');
    expect(callout.textContent).toContain('Disconnected');
  });

  it('restart_pending true: durable callout shows and persists across a remount (page reload)', async () => {
    mockBackend({
      cloudflareConfig: {
        json: {
          ...cfConfig('token', 'pubky.example.com').json,
          restart_pending: true,
          restart_reason: 'setup_changed',
        },
      },
    });
    const first = renderDialog();
    await waitFor(() => expect(screen.getByTestId('restart-callout')).toBeTruthy());
    expect(screen.getByTestId('restart-callout').textContent).toContain(
      'publishes your public address to the Pubky network',
    );
    first.unmount();
    // A fresh mount has no session state at all; the callout must come back
    // purely from the server-derived signal.
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('restart-callout')).toBeTruthy());
  });

  it('restart_pending true with config_changed names the config change', async () => {
    mockBackend({
      cloudflareConfig: {
        json: {
          ...cfConfig('token', 'pubky.example.com').json,
          restart_pending: true,
          restart_reason: 'config_changed',
        },
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('restart-callout')).toBeTruthy());
    expect(screen.getByTestId('restart-callout').textContent).toContain('configuration changes');
  });

  it('restart_pending false suppresses stale in-session callouts (the wrapper has run)', async () => {
    const backend = mockBackend({
      cloudflareConfig: {
        json: { ...cfConfig('token', 'pubky.example.com').json, restart_pending: false, restart_reason: null },
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-disconnect')).toBeTruthy());
    expect(screen.queryByTestId('restart-callout')).toBeNull();
    // Disconnect sets the in-session message, but the re-fetched server
    // signal still says false: no stale "restart to finish" callout.
    fireEvent.click(screen.getByTestId('cf-disconnect'));
    backend.cloudflareConfig = { json: { ...cfConfig('off').json, restart_pending: false, restart_reason: null } };
    fireEvent.click(screen.getByTestId('cf-disconnect'));
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge').textContent).toBe('Off'));
    expect(screen.queryByTestId('restart-callout')).toBeNull();
  });

  it('restart_pending null (no boot stamp) falls back to the in-session behavior', async () => {
    const backend = mockBackend({
      cloudflareConfig: {
        json: { ...cfConfig('token', 'pubky.example.com').json, restart_pending: null, restart_reason: null },
      },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-disconnect')).toBeTruthy());
    expect(screen.queryByTestId('restart-callout')).toBeNull();
    fireEvent.click(screen.getByTestId('cf-disconnect'));
    backend.cloudflareConfig = { json: { ...cfConfig('off').json, restart_pending: null, restart_reason: null } };
    fireEvent.click(screen.getByTestId('cf-disconnect'));
    await waitFor(() => expect(screen.getByTestId('restart-callout')).toBeTruthy());
    expect(screen.getByTestId('restart-callout').textContent).toContain('Disconnected');
  });

  it('published indicator: /info advertising the configured domain shows Published', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('token', 'pubky.example.com'),
      adminInfo: { pkarr_icann_domain: 'pubky.example.com:443' },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-status-published')).toBeTruthy());
    expect(screen.getByTestId('cf-status-published').textContent).toBe('Published');
    expect(screen.queryByTestId('cf-status-unpublished')).toBeNull();
  });

  it('published indicator: /info still on another domain shows Restart to publish', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('connect', 'pubky.example.com'),
      adminInfo: { pkarr_icann_domain: 'localhost:6286' },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-status-unpublished')).toBeTruthy());
    expect(screen.getByTestId('cf-status-unpublished').textContent).toBe('Restart to publish');
    expect(screen.queryByTestId('cf-status-published')).toBeNull();
    // Reachability stays its own, separate chip.
    await waitFor(() => expect(screen.getByTestId('cf-status-reachable')).toBeTruthy());
  });

  it('a setup completing in this session points at the next step (invites + Pubky Ring)', async () => {
    const backend = mockBackend({ cloudflareConfig: cfConfig('off') });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-manual-toggle')).toBeTruthy());
    expect(screen.queryByTestId('cf-next-step')).toBeNull();
    fireEvent.click(screen.getByTestId('cf-manual-toggle'));
    fireEvent.change(screen.getByLabelText('Public address'), { target: { value: 'pubky.example.com' } });
    fireEvent.change(screen.getByLabelText('Tunnel token'), { target: { value: 'tunnel-token' } });
    backend.cloudflareConfig = cfConfig('token', 'pubky.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('cf-next-step')).toBeTruthy());
    expect(screen.getByTestId('cf-next-step').textContent).toContain('create an invite in the Invites tab');
    expect(screen.getByTestId('cf-next-step').textContent).toContain('Pubky Ring');
  });

  it('a mode already active from a previous session shows no next-step line', async () => {
    mockBackend({ cloudflareConfig: cfConfig('token', 'pubky.example.com') });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.queryByTestId('cf-next-step')).toBeNull();
  });

  it('a 500 keeps the tab with a retry state instead of hiding it as unsupported', async () => {
    const backend = mockBackend({
      cloudflareConfig: { status: 500, json: { error: 'Could not read the Cloudflare configuration' } },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-unavailable')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Cloudflare' })).toBeTruthy();
    expect(within(screen.getByTestId('cf-unavailable')).getByText(/temporarily unavailable/)).toBeTruthy();

    backend.cloudflareConfig = cfConfig('off');
    fireEvent.click(screen.getByTestId('cf-retry'));
    await waitFor(() => expect(screen.getByTestId('cf-mode-badge')).toBeTruthy());
    expect(screen.queryByTestId('cf-unavailable')).toBeNull();
  });

  it('maps a 530/1033 probe result to a tunnel-not-connected message instead of a raw status', async () => {
    mockBackend({
      cloudflareConfig: cfConfig('token', 'pubky.example.com'),
      publicHealth: { ok: false, status: 530 },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-status-unreachable')).toBeTruthy());
    const chip = screen.getByTestId('cf-status-unreachable');
    expect(chip.textContent).toContain('Tunnel not connected. If you just set this up, give it a moment.');
    expect(chip.textContent).toContain('Restart the Pubky Homeserver app from Umbrel');
    expect(chip.textContent).not.toContain('HTTP 530');
    // The long reason renders on its own wrapping block, not as an inline chip
    // crammed into the address/actions row (which forced horizontal scroll).
    expect(chip.tagName).toBe('P');
    expect(chip.className).toContain('break-words');
  });

  it('disconnect: consequences are stated after arming, and Cancel disarms without a call', async () => {
    const backend = mockBackend({ cloudflareConfig: cfConfig('token', 'pubky.example.com') });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('cf-disconnect')).toBeTruthy());
    expect(screen.queryByTestId('cf-disconnect-consequences')).toBeNull();

    fireEvent.click(screen.getByTestId('cf-disconnect'));
    expect(screen.getByTestId('cf-disconnect').textContent).toBe('Confirm?');
    const consequences = screen.getByTestId('cf-disconnect-consequences').textContent ?? '';
    expect(consequences).toContain("Removes this dashboard's Cloudflare setup");
    expect(consequences).toContain('stay in your Cloudflare account');
    expect(consequences).toContain('public address stops working after the next restart');

    fireEvent.click(screen.getByTestId('cf-disconnect-cancel'));
    expect(screen.queryByTestId('cf-disconnect-consequences')).toBeNull();
    expect(screen.getByTestId('cf-disconnect').textContent).toBe('Disconnect');
    expect(backend.disconnectCalls).toBe(0);
  });

  it('supported:false still hides the tab (genuine unsupported environment)', async () => {
    mockBackend({
      cloudflareConfig: { json: { domain: null, mode: 'off', configured: false, supported: false } },
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText('Settings are not available in this environment.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Cloudflare' })).toBeNull();
  });

  it('post-setup health probe chain stops on unmount (no probes fire after the dialog is gone)', async () => {
    // Fake timers from the start; waitFor would hang under them, so each step
    // settles its microtasks via advanceTimersByTimeAsync(0) and asserts directly.
    vi.useFakeTimers();
    try {
      // An unreachable domain keeps the chain re-arming (up to 4 attempts);
      // exactly the case where a leaked timer would keep probing after unmount.
      const backend = mockBackend({
        cloudflareConfig: cfConfig('off'),
        connect: { supported: true, status: 'idle' },
        publicHealth: { ok: false, status: 503 },
      });
      const view = renderDialog();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('cf-connect-start')).toBeTruthy();

      // Drive the connect flow to completion so the dialog arms the chain.
      backend.connect = { supported: true, status: 'authorized', authorized_domain: 'example.com' };
      fireEvent.click(screen.getByTestId('cf-connect-start'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByTestId('cf-connect-subdomain'), { target: { value: 'pubky' } });
      backend.connect = { ok: true, status: 'completed', hostname: 'pubky.example.com' };
      backend.cloudflareConfig = cfConfig('connect', 'pubky.example.com');
      fireEvent.click(screen.getByTestId('cf-connect-complete'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('cf-connect-success')).toBeTruthy();

      const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
      const probeCalls = () =>
        fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/public-health')).length;
      const before = probeCalls();

      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(probeCalls()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
