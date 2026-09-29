import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeState {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

export function resolveDark(theme: ThemePreference): boolean {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }
  return theme === 'dark';
}

export function applyTheme(theme: ThemePreference): void {
  document.documentElement.classList.toggle('dark', resolveDark(theme));
}

// Storage key must match the pre-paint script in index.html.
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    { name: 'tracelayer-theme' },
  ),
);

/** Re-applies the theme when the OS color scheme changes while "system" is selected. */
export function useSystemThemeSync(): void {
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
}
