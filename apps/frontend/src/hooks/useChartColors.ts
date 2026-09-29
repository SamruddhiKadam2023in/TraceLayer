import { useSyncExternalStore } from 'react';

/**
 * Chart colours come from the same CSS variables as the rest of the UI, so charts follow the
 * light/dark theme. SVG attributes cannot use var() reliably, so the resolved values are read
 * from the document and re-read whenever the theme class on <html> changes.
 */
const TOKENS = {
  accent: '--tl-accent',
  ok: '--tl-ok',
  warn: '--tl-warn',
  fail: '--tl-fail',
  grid: '--tl-line',
  text: '--tl-fg-muted',
  subtle: '--tl-fg-subtle',
  surface: '--tl-surface',
} as const;

export type ChartColors = Record<keyof typeof TOKENS, string>;

const FALLBACK: ChartColors = {
  accent: '#2f5bea',
  ok: '#0f7a4a',
  warn: '#9a5b00',
  fail: '#c0262d',
  grid: '#e2e5ea',
  text: '#4b5260',
  subtle: '#6b7280',
  surface: '#ffffff',
};

let cached: ChartColors | null = null;
let cachedKey = '';

function read(): ChartColors {
  const root = document.documentElement;
  // Cache per theme class so repeated renders return the same object (stable for React).
  const key = root.className;
  if (cached && cachedKey === key) return cached;
  const style = getComputedStyle(root);
  const colors = { ...FALLBACK };
  for (const [name, variable] of Object.entries(TOKENS) as [keyof ChartColors, string][]) {
    const value = style.getPropertyValue(variable).trim();
    if (value) colors[name] = value;
  }
  cached = colors;
  cachedKey = key;
  return colors;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export function useChartColors(): ChartColors {
  return useSyncExternalStore(subscribe, read, () => FALLBACK);
}
