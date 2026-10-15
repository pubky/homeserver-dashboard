import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/organisms/LoginForm';
import { SESSION_COOKIE, dashboardPassword, hasValidSession } from '@/lib/server/session';

export const metadata = {
  title: 'Log in - Pubky Homeserver',
};

export default async function LoginPage() {
  const cookieStore = await cookies();
  if (dashboardPassword() === undefined || hasValidSession(cookieStore.get(SESSION_COOKIE)?.value)) {
    redirect('/dashboard');
  }
  return <LoginForm />;
}
