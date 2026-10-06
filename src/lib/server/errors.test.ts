// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RouteError, errorResponse, isAbortError, toRouteError } from './errors';
import { INERT_DOCUMENT_HEADERS } from './inert-content';

describe('RouteError', () => {
  it('carries status, type and public message', () => {
    const error = new RouteError(502, 'upstream_error', 'Upstream broke');
    expect(error.status).toBe(502);
    expect(error.type).toBe('upstream_error');
    expect(error.publicMessage).toBe('Upstream broke');
    expect(error.message).toBe('Upstream broke');
  });

  it('keeps an internal message separate from the public one', () => {
    const error = new RouteError(500, 'internal_error', 'Something went wrong', 'ECONNREFUSED 10.0.0.1');
    expect(error.message).toBe('ECONNREFUSED 10.0.0.1');
    expect(error.publicMessage).toBe('Something went wrong');
  });
});

describe('isAbortError', () => {
  it('recognizes AbortError and TimeoutError instances', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(timeout)).toBe(true);
  });

  it('recognizes plain objects with an abort-like name', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError({ name: 'TimeoutError' })).toBe(true);
    expect(isAbortError({ name: 'TypeError' })).toBe(false);
  });

  it('rejects everything else', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('toRouteError', () => {
  it('passes an existing RouteError through unchanged', () => {
    const original = new RouteError(404, 'not_found', 'Missing');
    expect(toRouteError(original)).toBe(original);
  });

  it('maps abort/timeout errors to a 504 timeout', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const mapped = toRouteError(abort, 'health check aborted');
    expect(mapped.status).toBe(504);
    expect(mapped.type).toBe('timeout');
    expect(mapped.publicMessage).toBe('Request timed out');
    expect(mapped.message).toBe('health check aborted');
  });

  it('maps unknown errors to a generic 500 without leaking details', () => {
    const mapped = toRouteError(new Error('secret internal detail'));
    expect(mapped.status).toBe(500);
    expect(mapped.type).toBe('internal_error');
    expect(mapped.publicMessage).toBe('An unexpected error occurred');
    expect(mapped.message).toBe('Request failed');
  });
});

describe('errorResponse', () => {
  it('is inert when opened as a document, since the message can echo the request', () => {
    const response = errorResponse(new RouteError(400, 'bad_request', 'Unsupported method: <script>'), 'req-1');
    for (const [name, value] of Object.entries(INERT_DOCUMENT_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('serializes a RouteError to the {error, type, requestId} envelope', async () => {
    const res = errorResponse(new RouteError(409, 'bad_request', 'Already running'), 'req-1');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Already running', type: 'bad_request', requestId: 'req-1' });
  });

  it('wraps arbitrary errors via toRouteError first', async () => {
    const res = errorResponse(new Error('boom'), 'req-2');
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.type).toBe('internal_error');
    expect(data.error).toBe('An unexpected error occurred');
    expect(data.requestId).toBe('req-2');
  });
});
