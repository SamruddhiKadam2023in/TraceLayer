import { useId, type ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  description?: string;
  tone?: 'default' | 'danger';
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  tone = 'default',
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`rounded-lg border bg-surface ${tone === 'danger' ? 'border-fail/40' : 'border-line'}`}
    >
      <div className="border-b border-line px-5 py-4">
        <h2
          id={headingId}
          className={`text-sm font-semibold ${tone === 'danger' ? 'text-fail' : ''}`}
        >
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
