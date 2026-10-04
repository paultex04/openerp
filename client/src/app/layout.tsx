import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

/**
 * The font variable is named `--font-geist`, not `--font-sans`.
 *
 * `globals.css` maps `--font-sans: var(--font-geist), ...` in `@theme inline`.
 * Had next/font written `--font-sans` directly, the theme entry would have
 * pointed at itself - the same self-reference cycle that made `shadcn init`'s
 * `.theme` block invalid - and `font-sans` would compute to nothing.
 */
const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: 'OpenERP',
  description:
    'ERP for industrial electrical and instrumentation contracting: rate build-up, job lifecycle and billing.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is for the font class only: next/font swaps the
    // variable at runtime, and the class string can differ by a hair between the
    // server and client render.
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
