import { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { proxyWebDavRequest } from './utils';

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

export const GET = withAdminAuth(handleGet);
export const POST = withAdminAuth(handlePost);
export const PUT = withAdminAuth(handlePut);
export const DELETE = withAdminAuth(handleDelete);
