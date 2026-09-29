import { Activity, FolderKanban, LayoutDashboard, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Sidebar entries. Each feature adds its entry in the phase that builds it. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/status', label: 'System status', icon: Activity },
  { to: '/settings', label: 'Settings', icon: Settings },
];
