import { create } from 'zustand';

export type ToastTone = 'danger' | 'success' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  /** In-app link, e.g. to the incident. */
  href?: string;
}

const MAX_TOASTS = 4;
const TOAST_MS = 8000;

interface ToastState {
  toasts: Toast[];
  show: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (toast) => {
    const id = nextId++;
    // Newest first; the oldest drop off so a burst never floods the screen.
    set((s) => ({ toasts: [{ ...toast, id }, ...s.toasts].slice(0, MAX_TOASTS) }));
    window.setTimeout(() => get().dismiss(id), TOAST_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
