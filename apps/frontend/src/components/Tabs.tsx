import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  /** Marks the tab, e.g. when its panel contains validation errors. */
  flagged?: boolean;
  /** Short suffix such as a count. */
  badge?: string;
}

interface TabsProps {
  label: string;
  tabs: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}

/** WAI-ARIA tabs: arrow keys move between tabs, the panel is labelled by its tab. */
export function Tabs({ label, tabs, selected, onSelect, children }: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === selected);
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${baseId}-tab-${tab.id}`)}`)
      ?.focus();
  };

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {tabs.map((tab) => {
          const isSelected = tab.id === selected;
          return (
            <button
              key={tab.id}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
                isSelected
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {tab.label}
              {tab.badge && <span className="text-xs text-fg-subtle">{tab.badge}</span>}
              {tab.flagged && (
                <span className="size-1.5 rounded-full bg-fail" aria-label="has errors" />
              )}
            </button>
          );
        })}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${selected}`}
        className="pt-4"
      >
        {children}
      </div>
    </div>
  );
}
