'use client';

/**
 * DualRailSidebar Master Navigation Shell.
 *
 * Coordinates the 56px NavIconRail and the 220px NavContextDrawer.
 * Supports Pinned mode (persistent side-by-side) and Unpinned mode (flyout overlay),
 * plus mobile slide-out drawer.
 */
import { Suspense } from 'react';
import { useDualRail } from '@/lib/nav-store';
import { NavIconRail } from './NavIconRail';
import { NavContextDrawer } from './NavContextDrawer';
import { useIsMobile } from '@/hooks/use-mobile';
import { useSidebar } from '@/components/ui/sidebar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { PanelLeft } from 'lucide-react';
import { cn } from 'cn';

export function DualRailTrigger({ className }: { className?: string }) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const { isPinned, togglePin } = useDualRail();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn('text-muted-foreground hover:text-foreground cursor-pointer', className)}
      onClick={() => {
        if (isMobile) {
          setOpenMobile(true);
        } else {
          togglePin();
        }
      }}
      title={
        isMobile
          ? 'Open navigation'
          : isPinned
            ? 'Unpin drawer to maximize table width [Ctrl+[]'
            : 'Pin drawer open [Ctrl+[]'
      }
      aria-label="Toggle navigation drawer"
    >
      <PanelLeft className="size-4.5" />
    </Button>
  );
}

export function DualRailSidebar() {
  const isMobile = useIsMobile();
  const { openMobile, setOpenMobile } = useSidebar();
  const { isPinned, flyoutOpen, setFlyoutOpen } = useDualRail();

  // Mobile layout: render inside a slide-over Sheet
  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="left" className="p-0 flex h-full w-[280px]">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation Menu</SheetTitle>
          </SheetHeader>
          <NavIconRail />
          <Suspense fallback={<div className="w-[220px] shrink-0 border-r bg-card/60" />}>
            <NavContextDrawer />
          </Suspense>
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop layout
  return (
    <div className="relative flex h-full shrink-0">
      {/* 56px Primary Icon Rail */}
      <NavIconRail />

      {/* 220px Context Drawer */}
      <Suspense fallback={<div className="w-[220px] shrink-0 border-r bg-card/60" />}>
        <NavContextDrawer />
      </Suspense>

      {/* Backdrop for unpinned flyout overlay: starts at left-14 so primary rail is never obscured or blocked */}
      {!isPinned && flyoutOpen && (
        <div
          className="fixed inset-y-0 left-14 right-0 z-30 bg-black/20 backdrop-blur-[1px] animate-in fade-in-0 duration-150"
          onClick={() => setFlyoutOpen(false)}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
