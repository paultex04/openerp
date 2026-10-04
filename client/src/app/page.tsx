'use client';

import Link from 'next/link';
import { usePermissions } from '@/components/auth/usePermissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  const { user, roles, loading } = usePermissions();

  const destinations = [
    {
      href: '/commercial',
      title: 'Commercial',
      description: 'Contracts, amendments, cost parameters, labour rate build-up and recipes.',
      permission: 'contract.read',
    },
    // Phase 3 adds Operations; Phase 4 adds Billing. Listed as disabled so the
    // navigation does not shift as phases land.
    {
      href: '#',
      title: 'Operations',
      description: 'Projects, job lifecycle and field actuals. Arrives in Phase 3.',
      permission: null,
    },
    {
      href: '#',
      title: 'Billing',
      description: 'Invoices and printable tax layout. Arrives in Phase 4.',
      permission: null,
    },
  ];

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">OpenERP</h1>
        <p className="text-muted-foreground">
          ERP for industrial electrical and instrumentation contracting.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading session…</p>
      ) : user ? (
        <div className="rounded-lg border p-4 text-sm">
          <p>
            Signed in as <span className="font-medium">{user.user.email}</span>
          </p>
          <p className="mt-1 text-muted-foreground">
            Employee {user.employee.name} {user.employee.surname} (#
            {user.employee.id})
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {roles.map((role) => (
              <Badge key={role} variant="outline">
                {role}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {user.permissions.length} effective permissions
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Not signed in. The API expects a session cookie; use the login endpoint to obtain one.
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        {destinations.map((d) => {
          const enabled =
            d.permission !== null && !loading && user?.permissions.includes(d.permission);

          return (
            <div key={d.title} className="rounded-lg border p-4">
              <h2 className="text-sm font-semibold">{d.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{d.description}</p>
              <div className="mt-3">
                {enabled ? (
                  <Link href={d.href}>
                    <Button size="sm">Open</Button>
                  </Link>
                ) : (
                  <Button size="sm" disabled>
                    {d.permission === null ? 'Coming soon' : 'Not permitted'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
