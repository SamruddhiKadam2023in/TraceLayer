import { NavLink } from 'react-router';
import { NAV_ITEMS } from '@/routes/navigation';

interface SidebarNavProps {
  /** Icon-only rendering for the collapsed desktop sidebar. */
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function SidebarNav({ collapsed = false, onNavigate }: SidebarNavProps) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-2">
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          title={collapsed ? label : undefined}
          aria-label={collapsed ? label : undefined}
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
              collapsed ? 'justify-center' : ''
            } ${
              isActive
                ? 'bg-surface-2 font-medium text-fg'
                : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`
          }
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {!collapsed && <span className="truncate">{label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}
