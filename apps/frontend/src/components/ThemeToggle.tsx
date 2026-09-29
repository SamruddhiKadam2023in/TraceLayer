import { Monitor, Moon, Sun } from 'lucide-react';
import { useThemeStore, type ThemePreference } from '@/stores/theme.store';

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light theme', Icon: Sun },
  { value: 'dark', label: 'Dark theme', Icon: Moon },
  { value: 'system', label: 'System theme', Icon: Monitor },
];

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="flex rounded-md border border-line p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={`rounded p-1.5 transition-colors ${
            theme === value ? 'bg-surface-2 text-fg' : 'text-fg-subtle hover:text-fg'
          }`}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
