'use client';

import { useState, type FormEvent } from 'react';
import { DashboardNavbar } from '@/components/organisms/DashboardNavbar';
import { usePlatform } from '@/components/providers/PlatformProvider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginForm() {
  const platform = usePlatform();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        window.location.assign('/dashboard');
        return;
      }
      setError(response.status === 401 ? 'Wrong password.' : 'Could not log in, try again.');
    } catch {
      setError('Could not reach the dashboard, try again.');
    }
    setSubmitting(false);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <DashboardNavbar showSettingsButton={false} />
        <Card>
          <CardHeader>
            <CardTitle>Log in</CardTitle>
            <CardDescription>
              {platform === 'umbrel'
                ? "Enter the dashboard password. Umbrel shows it when you open the app, and in the app's Settings under Default credentials (right-click the app icon, then Settings)."
                : 'Enter the dashboard password.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="dashboard-password">Password</Label>
                <Input
                  id="dashboard-password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              {error && (
                <Alert variant="destructive" data-testid="login-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={submitting || password === ''}>
                {submitting ? 'Logging in...' : 'Log in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
