import { NextRequest } from 'next/server';
import { proxyWebDavRequest } from './utils';
import { withSession } from '@/lib/server/session';

// Handle root WebDAV requests (/api/webdav without trailing slash)
// Forward to the catch-all route handler with empty path array
async function handleGet(request: NextRequest) {
  return proxyWebDavRequest(request, Promise.resolve({ path: [] }), 'GET');
}

async function handlePost(request: NextRequest) {
  return proxyWebDavRequest(request, Promise.resolve({ path: [] }), 'POST');
}

async function handlePut(request: NextRequest) {
  return proxyWebDavRequest(request, Promise.resolve({ path: [] }), 'PUT');
}

async function handleDelete(request: NextRequest) {
  return proxyWebDavRequest(request, Promise.resolve({ path: [] }), 'DELETE');
}

export const GET = withSession(handleGet);
export const POST = withSession(handlePost);
export const PUT = withSession(handlePut);
export const DELETE = withSession(handleDelete);
