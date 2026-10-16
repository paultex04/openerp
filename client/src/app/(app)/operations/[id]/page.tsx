'use client';

import { use, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JobDetail } from '@/components/job-management/job-detail';

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { id } = use(params);
  const jobId = Number(id);

  useEffect(() => {
    // When this page mounts, scroll to top
    const scrollContainer = document.getElementById('main-scroll-container');
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }, []);

  const handleBack = () => {
    // The job screen's `?tab=` is not a register filter; strip it so "back to jobs"
    // reconstructs the list rather than carrying a section key the register ignores.
    const next = new URLSearchParams(searchParams.toString());
    next.delete('tab');
    const query = next.toString();
    router.replace(query ? `/operations?${query}` : '/operations', { scroll: false });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={handleBack} className="gap-1 px-2">
          <ArrowLeft className="size-4" />
          Back to jobs
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <JobDetail jobId={jobId} onClose={handleBack} />
      </div>
    </div>
  );
}
