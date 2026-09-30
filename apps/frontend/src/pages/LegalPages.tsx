import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '@/components/Logo';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
          <Link to="/welcome" className="rounded-md">
            <Logo />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-6 flex flex-col gap-4 text-sm leading-relaxed text-fg-muted [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-fg">
          {children}
        </div>
      </main>
    </div>
  );
}

/** What this installation stores. TraceLayer is self-hosted: the operator controls the data. */
export function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p>
        TraceLayer is self-hosted software. Everything described here is stored in the database of
        the installation you are using, controlled by whoever runs it.
      </p>
      <h2>What is stored</h2>
      <ul className="list-disc pl-5">
        <li>Your account: name, email address, and a bcrypt hash of your password.</li>
        <li>
          Workspaces, projects, endpoints and monitors you create, and the results of requests and
          checks they run.
        </li>
        <li>
          Secret variables, encrypted with AES-256-GCM; they are never shown again once saved.
        </li>
        <li>Incident timelines, including comments and who made each change.</li>
      </ul>
      <h2>What is not collected</h2>
      <p>
        No analytics, tracking or third-party scripts are loaded, and no cookies are set other than
        the one that keeps you signed in.
      </p>
      <h2>Email</h2>
      <p>Email is sent only to notification channels your workspace configures, for alerts.</p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms">
      <p>
        TraceLayer is provided as is, without warranty of any kind. The people running this
        installation are responsible for how it is used.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Only monitor and send requests to APIs you are allowed to call. TraceLayer blocks requests
        to private and internal networks, but it cannot know which public APIs you may use.
      </p>
    </LegalPage>
  );
}
