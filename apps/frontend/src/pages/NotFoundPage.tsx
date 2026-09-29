import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-24 text-center">
      <p className="font-mono text-sm text-fg-subtle">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-fg-muted">The page you requested does not exist.</p>
      <Link to="/" className="text-sm font-medium text-accent hover:underline">
        Back to TraceLayer
      </Link>
    </div>
  );
}
