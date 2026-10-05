'use client';

/**
 * Development-only sign-in shortcuts.
 *
 * Filling in six email addresses by hand, several of which are easy to mistype,
 * is friction that has nothing to do with what is being tested. This fills the
 * form so a reviewer can get to a specific role's view in one click.
 *
 * ## It is off unless you turn it on
 *
 * Nothing renders unless `NEXT_PUBLIC_DEMO_LOGIN=1`. That is deliberately a
 * separate switch from the ordinary build, because a login page that offers
 * "sign in as Administrator" is a genuinely dangerous thing to ship by accident,
 * and "it was only in dev" is not a control anyone can verify from the outside.
 * The seed already refuses to create these accounts when `NODE_ENV=production`;
 * this is the second lock on the same door, not a substitute for it.
 *
 * ## The email is free, the password is not
 *
 * Filling the email needs no secret at all, so it always works. Filling the
 * password cannot be done from the browser without putting the password in the
 * client bundle - `NEXT_PUBLIC_*` values are inlined at build time and there is
 * no other way. So the password is strictly opt-in via
 * `NEXT_PUBLIC_DEMO_PASSWORD`, and when it is absent the buttons fill the email
 * and say so.
 *
 * That split is deliberate. The tedious part of testing a role is the email; the
 * password is one field the browser remembers after the first sign-in. So the
 * default is safe, and enabling the password is a knowing act with a visible
 * warning above the buttons.
 *
 * ## Rotating the demo password
 *
 * The password lives in two places, because the API and the browser read env
 * from different directories: `server` reads the repo root `.env`, and Next reads
 * `client/.env.local`. Rotate both. A stale `client/.env.local` produces a
 * failed sign-in rather than a wrong grant, so it fails loudly.
 */

import { FlaskConical, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The seeded accounts, with the role each one exercises.
 *
 * Kept in step with `DEMO_USERS` in `server/src/db/seed.ts`. The administrator is
 * listed separately because the seed gives them a different password from the
 * shared demo one.
 */
interface DemoAccount {
  email: string;
  /** Short role label, which is also the button's accessible name. */
  role: string;
  name: string;
  password?: string;
}

const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;
const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_DEMO_ADMIN_PASSWORD;

const ROLE_ACCOUNTS: readonly DemoAccount[] = [
  {
    email: 'bongani.d@contractor.co.za',
    role: 'Commercial / QS',
    name: 'Bongani Dlamini',
    password: DEMO_PASSWORD,
  },
  {
    email: 'pm@contractor.co.za',
    role: 'Project Manager',
    name: 'Nomsa Khumalo',
    password: DEMO_PASSWORD,
  },
  {
    email: 'billing@contractor.co.za',
    role: 'Billing Clerk',
    name: 'Riaan Botha',
    password: DEMO_PASSWORD,
  },
  {
    email: 'david.m@contractor.co.za',
    role: 'Site Supervisor',
    name: 'David Mokoena',
    password: DEMO_PASSWORD,
  },
  {
    email: 'sipho.z@contractor.co.za',
    role: 'Site Supervisor',
    name: 'Sipho Zulu',
    password: DEMO_PASSWORD,
  },
];

const ADMIN_ACCOUNT: DemoAccount = {
  email: 'admin@contractor.co.za',
  role: 'Administrator',
  name: 'System Administrator',
  password: ADMIN_PASSWORD,
};

export function DemoAccounts({
  onFill,
}: {
  onFill: (email: string, password: string | null) => void;
}) {
  // The single gate. Absent, false, or any other value means nothing renders.
  if (process.env.NEXT_PUBLIC_DEMO_LOGIN !== '1') return null;

  const accounts = [ADMIN_ACCOUNT, ...ROLE_ACCOUNTS];
  const anyPasswordMissing = accounts.some((account) => !account.password);

  return (
    <div className="space-y-3">
      {/*
        A visible warning, not a subtle footnote. The person looking at this screen
        needs to know these are shared credentials, and that when the password is
        filled it is readable in the page source. The only place they reliably
        see that is here.
      */}
      <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs leading-relaxed text-muted-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          <strong className="text-foreground">Development sign-in shortcuts.</strong> Seeded
          accounts that share one password
          {anyPasswordMissing
            ? '. Only the email is filled below.'
            : ', and that password is readable in the page source.'}{' '}
          Do not enable this on a shared or reachable deployment.
        </span>
      </p>

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
          <FlaskConical aria-hidden="true" className="size-3.5 text-muted-foreground" />
          Fill the form as a role
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {accounts.map((account) => (
            <li key={account.email}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onFill(account.email, account.password ?? null)}
              >
                {account.role}
                <span className="sr-only">
                  {' '}
                  — fill {account.name}, {account.email}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {anyPasswordMissing && (
        <p className="text-xs text-muted-foreground">
          The buttons fill the email only. To fill the password too, set{' '}
          <code className="font-mono text-[11px]">NEXT_PUBLIC_DEMO_PASSWORD</code> in{' '}
          <code className="font-mono text-[11px]">client/.env.local</code> — note that a password
          set there is inlined into the page bundle.
        </p>
      )}
    </div>
  );
}
