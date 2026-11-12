import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiExplorer, resolveRequestUrl } from './ApiExplorer';

describe('resolveRequestUrl', () => {
  it('routes admin endpoints through the admin proxy', () => {
    expect(resolveRequestUrl('admin', '/info')).toBe('/api/admin/info');
    expect(resolveRequestUrl('admin', '/users?limit=20')).toBe('/api/admin/users?limit=20');
    expect(resolveRequestUrl('admin', '/')).toBe('/api/admin/');
  });

  it('routes admin /dav endpoints through the WebDAV proxy', () => {
    expect(resolveRequestUrl('admin', '/dav/pk1/pub/file.txt')).toBe('/api/webdav/pk1/pub/file.txt');
    expect(resolveRequestUrl('admin', '/dav')).toBe('/api/webdav/');
    // /davsomething is not a WebDAV path
    expect(resolveRequestUrl('admin', '/davros')).toBe('/api/admin/davros');
  });

  it('routes client endpoints through the client proxy', () => {
    expect(resolveRequestUrl('client', '/signup')).toBe('/api/client-proxy/signup');
    expect(resolveRequestUrl('client', '/events/?limit=10')).toBe('/api/client-proxy/events/?limit=10');
    expect(resolveRequestUrl('client', '/')).toBe('/api/client-proxy/');
  });

  it('routes metrics endpoints through the metrics proxy', () => {
    expect(resolveRequestUrl('metrics', '/metrics')).toBe('/api/metrics-proxy/metrics');
  });

  it('normalizes a missing leading slash without collapsing anything else', () => {
    expect(resolveRequestUrl('client', 'events/')).toBe('/api/client-proxy/events/');
    // The old regex collapse would have turned embedded "//" into "/".
    expect(resolveRequestUrl('client', '/a//b')).toBe('/api/client-proxy/a//b');
  });
});

describe('ApiExplorer', () => {
  beforeAll(() => {
    // jsdom lacks these; Radix Select needs them.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    window.HTMLElement.prototype.hasPointerCapture = vi.fn();
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    class MockPointerEvent extends Event {
      button: number;
      ctrlKey: boolean;
      pointerType: string;
      constructor(type: string, props: PointerEventInit = {}) {
        super(type, props);
        this.button = props.button ?? 0;
        this.ctrlKey = props.ctrlKey ?? false;
        this.pointerType = props.pointerType ?? 'mouse';
      }
    }
    window.PointerEvent = MockPointerEvent as unknown as typeof PointerEvent;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the same-origin admin proxy as the default base URL', () => {
    render(<ApiExplorer />);
    expect(screen.getByText('/api/admin')).toBeTruthy();
  });

  it('sends an admin request through the admin proxy', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    render(<ApiExplorer />);

    fireEvent.change(screen.getByPlaceholderText('/info'), { target: { value: '/info' } });
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/admin/info');
  });

  it('switching to the client server routes requests through the client proxy', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    render(<ApiExplorer />);

    // First combobox is the server selector.
    const serverSelect = screen.getAllByRole('combobox')[0];
    fireEvent.pointerDown(serverSelect, { button: 0, ctrlKey: false });
    const clientOption = await screen.findByText('Client Server');
    fireEvent.pointerUp(clientOption);
    fireEvent.click(clientOption);

    await waitFor(() => expect(screen.getByText('/api/client-proxy')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('/info'), { target: { value: '/events/' } });
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/client-proxy/events/');
  });
});
