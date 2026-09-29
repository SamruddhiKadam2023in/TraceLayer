import { Activity, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Sidebar entries. Each feature adds its entry in the phase that builds it. */
export const NAV_ITEMS: NavItem[] = [{ to: '/status', label: 'System status', icon: Activity }];
