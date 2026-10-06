import { JobRegister } from '@/components/job-management/job-register';

/**
 * Job Management: one page, two tables.
 *
 * Replaces Operations' three sidebar entries (Projects Register, Jobs Board and the
 * Valuation Packs deep link). See `components/job-management/job-register.tsx` for
 * why, and for the layout decisions.
 *
 * A server component, so the register's initial HTML carries the heading and the
 * page shell; the table itself is client-side because search, pagination and inline
 * editing all are.
 */
export default function OperationsPage() {
  return <JobRegister />;
}
