/**
 * Placeholder landing page.
 *
 * Phase 1 delivers the API, schema and RBAC. The login flow and application
 * shell arrive with the Phase 2 commercial views.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">OpenERP</h1>
        <p className="text-muted-foreground">
          ERP for industrial electrical and instrumentation contracting.
        </p>
      </div>

      <dl className="grid gap-3 rounded-lg border p-6 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="font-medium">Phase</dt>
          <dd className="text-muted-foreground">1 &mdash; Database, Authentication &amp; RBAC</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-medium">API</dt>
          <dd className="text-muted-foreground">/health &middot; /api/auth/*</dd>
        </div>
      </dl>
    </main>
  );
}
