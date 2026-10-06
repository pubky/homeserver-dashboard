import { NextResponse } from 'next/server';
import { INERT_DOCUMENT_HEADERS } from '@/lib/server/inert-content';

export type ErrorType =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'upstream_error'
  | 'config_error'
  | 'not_supported'
  | 'internal_error';

export class RouteError extends Error {
  status: number;
  type: ErrorType;
  publicMessage: string;

  constructor(status: number, type: ErrorType, publicMessage: string, message?: string) {
    super(message || publicMessage);
    this.status = status;
    this.type = type;
    this.publicMessage = publicMessage;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = String((error as { name?: unknown }).name);
    return name === 'AbortError' || name === 'TimeoutError';
  }
  return false;
}

export function toRouteError(error: unknown, fallbackMessage: string = 'Request failed'): RouteError {
  if (error instanceof RouteError) return error;
  if (isAbortError(error)) return new RouteError(504, 'timeout', 'Request timed out', fallbackMessage);
  return new RouteError(500, 'internal_error', 'An unexpected error occurred', fallbackMessage);
}

export function errorResponse(error: unknown, requestId: string, fallbackMessage?: string): NextResponse {
  const routeError = toRouteError(error, fallbackMessage);
  return NextResponse.json(
    {
      error: routeError.publicMessage,
      type: routeError.type,
      requestId,
    },
    // Error text can echo the request, so it is never displayed as a page.
    { status: routeError.status, headers: INERT_DOCUMENT_HEADERS },
  );
}
