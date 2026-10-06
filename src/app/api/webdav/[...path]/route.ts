import { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { proxyWebDavRequest } from '../utils';

// Handle all HTTP methods for WebDAV
async function handleGet(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyWebDavRequest(request, params, 'GET');
}

async function handlePut(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyWebDavRequest(request, params, 'PUT');
}

async function handleDelete(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyWebDavRequest(request, params, 'DELETE');
}

async function handlePost(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxyWebDavRequest(request, params, 'POST');
}

export const GET = withAdminAuth(handleGet);
export const PUT = withAdminAuth(handlePut);
export const DELETE = withAdminAuth(handleDelete);
export const POST = withAdminAuth(handlePost);
