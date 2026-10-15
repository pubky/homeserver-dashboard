import { NextRequest } from 'next/server';
import { proxyWebDavRequest } from '../utils';
import { withSession } from '@/lib/server/session';

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

export const GET = withSession(handleGet);
export const PUT = withSession(handlePut);
export const DELETE = withSession(handleDelete);
export const POST = withSession(handlePost);
