import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { DashboardNavbar } from '@/components/organisms/DashboardNavbar';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';

export const metadata = {
  title: 'Cloudflare Tunnel Setup - Pubky Homeserver',
  description: 'Step-by-step guide for exposing a Pubky Homeserver publicly via Cloudflare Tunnel.',
};

export default function CloudflareGuidePage() {
  const platform = getPlatform();
  const restartSentence = restartAppSentence(platform);

  // Cloudflare setup runs as part of the Umbrel app's containers; it is not
  // available in a standalone deployment, so the guide does not apply.
  if (platform !== 'umbrel') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
            <DashboardNavbar showSettingsButton={false} />
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Link>
            <div className="rounded-lg border border-border bg-card p-6" data-testid="cloudflare-guide-standalone">
              <h1 className="mb-2 text-xl font-semibold">Cloudflare Tunnel setup isn&apos;t available here</h1>
              <p className="text-sm text-muted-foreground">
                The guided Cloudflare Tunnel flow runs as part of the Pubky Homeserver Umbrel app and isn&apos;t
                available in a standalone deployment. To expose your homeserver publicly, set up your own reverse proxy
                or tunnel pointing at the homeserver&apos;s HTTP port, then make sure it&apos;s reachable at your
                domain.
              </p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
          <DashboardNavbar showSettingsButton={false} />

          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>

          <article className="flex flex-col gap-8">
            <header className="flex flex-col gap-2">
              <h1 className="text-2xl font-semibold sm:text-3xl">Cloudflare Tunnel Setup</h1>
              <p className="text-sm text-muted-foreground sm:text-base">
                Expose your Pubky Homeserver to the public internet via a Cloudflare Tunnel, no port forwarding
                required. The whole setup takes about 5 minutes.
              </p>
            </header>

            <Section id="prerequisites" title="Prerequisites">
              <ul className="ml-5 list-disc space-y-2 text-sm sm:text-base">
                <li>
                  <strong>A domain on Cloudflare.</strong> Cloudflare must be managing its DNS, i.e., the domain appears
                  under <em>Websites</em> on{' '}
                  <ExternalLink href="https://dash.cloudflare.com/">dash.cloudflare.com</ExternalLink>. Free plan is
                  fine.
                </li>
                <li>
                  <strong>A Pubky Homeserver running on Umbrel.</strong> The Settings dialog (gear icon, top-right)
                  should show a <em>Cloudflare</em> tab.
                </li>
                <li>
                  <strong>An idea of which subdomain you want</strong>, e.g. <Code>pubky.yourdomain.com</Code> or{' '}
                  <Code>hs.yourdomain.com</Code>.
                </li>
              </ul>
            </Section>

            <Section id="cloudflare-side" title="Part A - Cloudflare side (create the tunnel)">
              <ol className="ml-5 list-decimal space-y-3 text-sm sm:text-base">
                <li>
                  Log in to <ExternalLink href="https://dash.cloudflare.com/">dash.cloudflare.com</ExternalLink>.
                </li>
                <li>
                  In the left sidebar, click <strong>Zero Trust</strong>. First-time visitors will be prompted to pick a
                  team name and plan, free tier is enough.
                </li>
                <li>
                  Inside Zero Trust, navigate to <strong>Networks → Connectors → Cloudflare Tunnels</strong>.
                </li>
                <li>
                  Click <strong>Add a tunnel</strong>.
                </li>
                <li>
                  Choose connector type <strong>Cloudflared</strong> → <strong>Next</strong>.
                </li>
                <li>
                  Name your tunnel (e.g. <Code>umbrel-pubky</Code>) → <strong>Save tunnel</strong>.
                </li>
                <li>
                  Cloudflare will show a screen titled <em>Install and run a connector</em> with per-OS install
                  commands. <strong>Do not run any of these commands</strong>, your Umbrel app already runs cloudflared.
                </li>
                <li>
                  What you want from this screen is the <strong>tunnel token</strong>. The Docker tab shows a command
                  like:
                  <CodeBlock>
                    docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token{' '}
                    <span className="text-brand">&lt;LONG-STRING&gt;</span>
                  </CodeBlock>
                  Copy the <Code>&lt;LONG-STRING&gt;</Code> part only (the value after <Code>--token</Code>). It starts
                  with <Code>eyJ</Code> and looks like base64. This is your tunnel token. Save it for Part B.
                </li>
                <li>
                  Click <strong>Next</strong>. Cloudflare may still say <em>No connectors installed</em> at this point,
                  that is expected, your connector activates after you finish Part B.
                </li>
                <li>
                  You are now on the <strong>Route traffic</strong> page. Open the{' '}
                  <strong>Published applications</strong> (or <em>Public hostnames</em>) tab.
                </li>
                <li>
                  Fill the fields:
                  <ul className="mt-2 ml-5 list-disc space-y-1">
                    <li>
                      <strong>Subdomain</strong>: <Code>pubky</Code> (or whatever you like)
                    </li>
                    <li>
                      <strong>Domain</strong>: pick yours from the dropdown
                    </li>
                    <li>
                      <strong>Path</strong>: leave empty
                    </li>
                    <li>
                      <strong>Service → Type</strong>: <Code>HTTP</Code> (not HTTPS)
                    </li>
                    <li>
                      <strong>Service → URL</strong>: <Code>homeserver:6286</Code>
                    </li>
                  </ul>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Port <Code>6286</Code> is the homeserver&apos;s HTTP listener. Not <Code>6288</Code> (admin) or{' '}
                    <Code>8812</Code> (this dashboard).
                  </p>
                </li>
                <li>
                  Click <strong>Save tunnel</strong>. Cloudflare creates the DNS record automatically.
                </li>
              </ol>
            </Section>

            <Section id="dashboard-side" title="Part B - Homeserver Dashboard side">
              <ol className="ml-5 list-decimal space-y-3 text-sm sm:text-base">
                <li>Open your Pubky Homeserver app from Umbrel.</li>
                <li>
                  Click the <strong>gear icon</strong> (Settings) in the top-right.
                </li>
                <li>
                  Switch to the <strong>Cloudflare</strong> tab.
                </li>
                <li>
                  Fill in:
                  <ul className="mt-2 ml-5 list-disc space-y-1">
                    <li>
                      <strong>Public address</strong>: the full hostname, e.g. <Code>pubky.example.com</Code> (no{' '}
                      <Code>https://</Code>, no path, no port)
                    </li>
                    <li>
                      <strong>Tunnel token</strong>: paste the token from step A-8
                    </li>
                  </ul>
                </li>
                <li>
                  Click <strong>Save</strong>.
                </li>
                <li>
                  {restartSentence} Wait 30 to 60 seconds.
                  <p className="mt-2 text-sm text-muted-foreground">
                    The tunnel itself usually connects within a minute of saving; the restart is what updates your
                    homeserver&apos;s published record so other Pubky tools find it at your public address (
                    <Code>icann_domain</Code> in config.toml is set automatically; no manual edit needed).
                  </p>
                </li>
              </ol>
            </Section>

            <Section id="verify" title="Part C - Verify">
              <ol className="ml-5 list-decimal space-y-3 text-sm sm:text-base">
                <li>
                  Back in Cloudflare → <strong>Zero Trust → Networks → Connectors → Cloudflare Tunnels</strong>, your
                  tunnel should now show <strong>Healthy</strong> (green).
                </li>
                <li>
                  In the dashboard&apos;s Cloudflare tab, click the <strong>Check</strong> button next to the saved
                  public address. Success means the tunnel is forwarding correctly.
                </li>
                <li>
                  From any device, <Code>curl https://pubky.example.com/</Code> should return a response from your
                  homeserver.
                </li>
                <li>
                  Optional: paste your homeserver&apos;s public key (shown on the dashboard Overview) into{' '}
                  <ExternalLink href="https://pkdns.net/">pkdns.net</ExternalLink>. The published record should point at
                  your public address, confirming other Pubky tools can discover your homeserver.
                </li>
              </ol>
            </Section>

            <Section id="gotchas" title="Gotchas">
              <div className="flex flex-col gap-3">
                <Gotcha title="Domain must be on Cloudflare DNS">
                  If the domain&apos;s nameservers point elsewhere, this will not work. Add the site on Cloudflare and
                  switch nameservers at your registrar first.
                </Gotcha>
                <Gotcha title="The Service URL is homeserver:6286, not your public address">
                  That field tells cloudflared <em>where inside the Umbrel network to send traffic</em>, not where
                  it&apos;s coming from. Easy to paste your own domain there by mistake.
                </Gotcha>
                <Gotcha title="HTTP, not HTTPS">
                  The homeserver inside the container speaks plain HTTP on 6286. Cloudflare handles the public TLS for
                  you. Selecting HTTPS makes cloudflared try to negotiate TLS with the homeserver and fail.
                </Gotcha>
                <Gotcha title="The token is shown only once">
                  If you lose it before saving in the dashboard, regenerate it from the same Cloudflare tunnel page
                  (open the tunnel → Configure → Refresh token). The old token is invalidated.
                </Gotcha>
                <Gotcha title="Multi-level subdomains need an Advanced Certificate">
                  e.g. <Code>pubky.internal.example.com</Code> (two levels before the apex) is not covered by
                  Cloudflare&apos;s free wildcard cert. Stick to a single level like <Code>pubky.example.com</Code>.
                </Gotcha>
                <Gotcha title="Use Umbrel's app restart, not a stop and start from inside the dashboard">
                  The cloudflared container only reads the token at container start, and stopping and starting the
                  homeserver from inside this dashboard does not touch that container. {restartSentence} That brings
                  both containers back up cleanly.
                </Gotcha>
                <Gotcha title="Do not change admin_password in config.toml">
                  On Umbrel the dashboard authenticates to the homeserver with a platform-generated password. Changing{' '}
                  <Code>admin_password</Code> disconnects the dashboard. Need the password for another tool (e.g.
                  pubky-cli)? Reveal it with the eye icon in Settings → Config.
                </Gotcha>
                <Gotcha title="Zero Trust is a different dashboard from regular Cloudflare">
                  Cloudflare has two dashboards now, the regular one for DNS/CDN and Zero Trust for tunnels.
                  They&apos;re cross-linked, but the URLs differ (<Code>dash.cloudflare.com</Code> vs{' '}
                  <Code>one.dash.cloudflare.com</Code>). Tunnels live in Zero Trust.
                </Gotcha>
              </div>
            </Section>
          </article>
        </div>
      </main>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <h2 className="text-xl font-semibold sm:text-2xl">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{children}</code>;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="my-3 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand underline-offset-2 hover:underline"
    >
      {children}
    </Link>
  );
}

function Gotcha({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
