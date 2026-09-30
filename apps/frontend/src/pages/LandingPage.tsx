import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Network,
  Radio,
  Siren,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAuthStore } from '@/stores/auth.store';

/** Set VITE_REPOSITORY_URL at build time to link the source code and its docs. */
const REPOSITORY_URL = (import.meta.env.VITE_REPOSITORY_URL as string | undefined) || null;

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Activity,
    title: 'API monitoring',
    text: 'Scheduled checks for availability, status codes, latency and response bodies, run by a dedicated worker with SSRF protection.',
  },
  {
    icon: BarChart3,
    title: 'Performance analytics',
    text: 'Uptime, error rate and P50/P95/P99 latency computed from every stored check, per endpoint, project or workspace.',
  },
  {
    icon: Siren,
    title: 'Incident detection',
    text: 'Alert rules open incidents with a timeline; your team acknowledges, assigns and comments, and recovery resolves them.',
  },
  {
    icon: Radio,
    title: 'Real-time alerts',
    text: 'Dashboards and incident pages update live over WebSockets, and email notifications go to on-call channels.',
  },
  {
    icon: Network,
    title: 'Dependency mapping',
    text: 'Draw how services depend on each other, or detect it from the hosts your endpoints call, with live health on the map.',
  },
];

const FLOW: { label: string; detail: string }[] = [
  { label: 'Endpoints', detail: 'Saved requests, environments and encrypted secrets' },
  { label: 'Scheduler', detail: 'Redis + BullMQ queue checks at each monitor’s interval' },
  { label: 'Worker', detail: 'Runs checks against your APIs, blocking private targets' },
  { label: 'PostgreSQL', detail: 'Stores every run; metrics are computed from them in SQL' },
  { label: 'Alerts', detail: 'Rules evaluated after each check open and resolve incidents' },
  { label: 'Dashboard', detail: 'Socket.IO pushes changes to every open browser' },
];

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-line py-16">
      <div className="mx-auto max-w-6xl px-4">
        <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="mt-2 max-w-2xl text-fg-muted">{lead}</p>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

/** Public landing page (spec §53): what TraceLayer does, how it works, and how to try it. */
export function LandingPage() {
  const signedIn = useAuthStore((s) => s.status === 'authenticated');

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <nav
          aria-label="Main"
          className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 text-sm"
        >
          <Link to="/welcome" className="rounded-md">
            <Logo />
          </Link>
          <a href="#features" className="hidden text-fg-muted hover:text-fg sm:inline">
            Features
          </a>
          <a href="#how-it-works" className="hidden text-fg-muted hover:text-fg sm:inline">
            How it works
          </a>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {signedIn ? (
              <Link
                to="/"
                className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg hover:opacity-90"
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="rounded-md px-3 py-1.5 font-medium hover:bg-surface-2">
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg hover:opacity-90"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pt-16 pb-12 sm:pt-24">
          <p className="font-mono text-xs tracking-wide text-accent uppercase">
            API reliability &amp; observability
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Know when your APIs fail.
            <br />
            <span className="text-fg-muted">Know why they fail.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-fg-muted">
            Monitor API reliability, performance and incidents from one developer-focused platform.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to={signedIn ? '/' : '/register'}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 font-medium text-accent-fg hover:opacity-90"
            >
              Get started
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <a
              href="#demo"
              className="inline-flex items-center rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-surface-2"
            >
              View demo
            </a>
          </div>

          <figure className="mt-14">
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <img
                src="/landing/dashboard-light.png"
                alt="The TraceLayer dashboard: an active incident, uptime, error rate and latency metrics, and latency and error-rate charts."
                width={1280}
                height={760}
                className="block w-full dark:hidden"
              />
              <img
                src="/landing/dashboard-dark.png"
                alt="The TraceLayer dashboard: an active incident, uptime, error rate and latency metrics, and latency and error-rate charts."
                width={1280}
                height={760}
                className="hidden w-full dark:block"
              />
            </div>
            <figcaption className="mt-3 text-center text-xs text-fg-subtle">
              The dashboard of the demo workspace (generated demo data, labelled as such in the
              app).
            </figcaption>
          </figure>
        </section>

        <Section
          id="features"
          title="Built for the people who run APIs"
          lead="Every number comes from checks TraceLayer actually ran, never from sample statistics."
        >
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="rounded-lg border border-line bg-surface p-5">
                <Icon className="size-5 text-accent" aria-hidden="true" />
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1 text-sm text-fg-muted">{text}</p>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          id="how-it-works"
          title="How it works"
          lead="A React app, an Express API and a separate worker, with PostgreSQL for data and Redis for queues and real-time fan-out."
        >
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FLOW.map(({ label, detail }, i) => (
              <li key={label} className="flex gap-3 rounded-lg border border-line bg-surface p-4">
                <span className="font-mono text-sm text-fg-subtle">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <p className="font-mono text-sm font-semibold">{label}</p>
                  <p className="mt-0.5 text-sm text-fg-muted">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          id="demo"
          title="Try the demo"
          lead="Load a demo workspace with three APIs, a week of monitor history and the incidents it caused. Its endpoints point at real public APIs, so you can send requests and resume monitors for real."
        >
          <div className="max-w-2xl rounded-lg border border-line bg-surface p-5 text-sm">
            <p className="font-medium">With the Docker stack running:</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs">
              docker compose exec backend node apps/backend/dist/scripts/seed-demo.js
            </pre>
            <p className="mt-3 text-fg-muted">
              It prints a sign-in for the demo account (a new random password each run), or add{' '}
              <code className="rounded bg-surface-2 px-1">--owner you@example.com</code> to add the
              demo workspace to your own account.
            </p>
            <Link
              to="/login"
              className="mt-4 inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
            >
              Sign in to explore it
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </Section>
      </main>

      <footer className="border-t border-line bg-surface">
        <nav
          aria-label="Footer"
          className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-fg-muted"
        >
          <Logo />
          {REPOSITORY_URL && (
            <>
              <a href={REPOSITORY_URL} className="hover:text-fg" rel="noreferrer">
                GitHub
              </a>
              <a
                href={`${REPOSITORY_URL}/tree/main/docs`}
                className="hover:text-fg"
                rel="noreferrer"
              >
                Documentation
              </a>
            </>
          )}
          <Link to="/privacy" className="hover:text-fg">
            Privacy
          </Link>
          <Link to="/terms" className="hover:text-fg">
            Terms
          </Link>
        </nav>
      </footer>
    </div>
  );
}
