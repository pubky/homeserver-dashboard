import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, hasValidSession } from '@/lib/server/session';

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  if (!hasValidSession(cookieStore.get(SESSION_COOKIE)?.value)) {
    redirect('/login');
  }
  return <>{children}</>;
}
