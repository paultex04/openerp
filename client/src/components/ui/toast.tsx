'use client';

/**
 * Minimal toast system.
 *
 * Deliberately dependency-free: a single context plus a fixed stack. Keeps the
 * commercial screens readable without pulling in a full toast framework for four
 * notification kinds.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'default' | 'success' | 'destructive';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; variant?: ToastVariant }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: 'border bg-background text-foreground',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  destructive: 'border-red-300 bg-red-50 text-red-950',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>(
    (input) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, variant: 'default', ...input }]);
      window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto rounded-md border p-3 text-sm shadow-lg',
              VARIANT_CLASSES[t.variant],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 text-xs opacity-80">{t.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-xs opacity-60 hover:opacity-100"
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider.');
  return context;
}
