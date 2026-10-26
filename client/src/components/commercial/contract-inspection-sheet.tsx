'use client';

/**
 * Contract & Amendments Slide-Over Inspection Sheet.
 *
 * Linear/Vercel-style drawer providing instant glance at contract details,
 * client VAT credentials, active amendments, and direct one-click navigation
 * into Rate Cards, Cost Parameters, or Recipe Builders for any amendment.
 */

import {
  ArrowUpRight,
  Building2,
  Calendar,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Layers,
  Percent,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { statusVariant } from '@/lib/lifecycle-status';
import type { ContractRow } from '@/lib/api';
import { formatDate, formatPercent } from '@/lib/format';

export interface ContractInspectionSheetProps {
  contract: ContractRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectAmendment?: (
    amendmentId: number,
    targetTab: 'parameters' | 'rates' | 'recipes',
  ) => void;
}

export function ContractInspectionSheet({
  contract,
  open,
  onOpenChange,
  onSelectAmendment,
}: ContractInspectionSheetProps) {
  if (!contract) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto p-0 flex flex-col bg-background/95 backdrop-blur-md border-l shadow-2xl"
      >
        <SheetHeader className="border-b p-5 pb-4 bg-card/60 sticky top-0 z-20 backdrop-blur-md">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <SheetTitle className="font-mono text-xl font-bold tracking-tight">
                Contract {contract.number}
              </SheetTitle>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {contract.type ?? 'Standard Agreement'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Building2 className="size-3 text-muted-foreground" />
              <span>{contract.client.name}</span>
            </p>
          </div>
        </SheetHeader>

        <div className="p-6 space-y-6 flex-1">
          {/* Description */}
          {contract.description && (
            <div className="rounded-lg border bg-card/40 p-3.5 text-sm">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                Agreement Scope
              </p>
              <p className="text-foreground/90 leading-relaxed">{contract.description}</p>
            </div>
          )}

          {/* Quick Facts */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border bg-card/60 p-2.5 space-y-1">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="size-3" />
                SARS VAT Status
              </span>
              <p className="text-xs font-semibold">
                {contract.client.isVatRegistered ? 'Registered (15%)' : 'Not Registered'}
              </p>
              {contract.client.vatNumber && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  VAT #{contract.client.vatNumber}
                </p>
              )}
            </div>

            <div className="rounded-lg border bg-card/60 p-2.5 space-y-1">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Layers className="size-3" />
                Active Projects
              </span>
              <p className="text-xs font-semibold font-mono">
                {contract._count?.projects ?? 0} {contract._count?.projects === 1 ? 'project' : 'projects'}
              </p>
            </div>

            <div className="rounded-lg border bg-card/60 p-2.5 space-y-1">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <FileText className="size-3" />
                Amendments Count
              </span>
              <p className="text-xs font-semibold font-mono">
                {contract.amendments.length} {contract.amendments.length === 1 ? 'schedule' : 'schedules'}
              </p>
            </div>
          </div>

          {/* Amendments Schedule */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Amendments & Commercial Schedules
              </h3>
              <span className="text-xs text-muted-foreground font-mono">
                {contract.amendments.length} total
              </span>
            </div>

            {contract.amendments.length === 0 ? (
              <p className="text-xs text-muted-foreground italic rounded border border-dashed p-4 text-center">
                No amendments attached to this agreement.
              </p>
            ) : (
              <div className="space-y-2.5">
                {contract.amendments.map((amendment) => (
                  <div
                    key={amendment.id}
                    className="rounded-lg border bg-card/80 p-3.5 space-y-2.5 transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {amendment.amendmentNumber}
                        </span>
                        <Badge variant={statusVariant(amendment.status)}>
                          {amendment.status}
                        </Badge>
                      </div>
                      <Badge variant="outline" className="font-mono text-[11px]">
                        VAT {formatPercent(amendment.vatRate)}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
                      <span className="flex items-center gap-1">
                        <Calendar className="size-3" />
                        Effective: {formatDate(amendment.effectiveDate)}
                      </span>
                      <span>→</span>
                      <span>Expires: {formatDate(amendment.expiryDate)}</span>
                    </div>

                    {onSelectAmendment && (
                      <div className="flex flex-wrap gap-2 pt-1 border-t border-border/40">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onSelectAmendment(amendment.id, 'rates');
                            onOpenChange(false);
                          }}
                          className="h-7 text-xs gap-1"
                        >
                          <FileSpreadsheet className="size-3" />
                          <span>Rate card</span>
                          <ArrowUpRight className="size-3 text-muted-foreground" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onSelectAmendment(amendment.id, 'parameters');
                            onOpenChange(false);
                          }}
                          className="h-7 text-xs gap-1"
                        >
                          <Percent className="size-3" />
                          <span>Cost parameters</span>
                          <ArrowUpRight className="size-3 text-muted-foreground" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onSelectAmendment(amendment.id, 'recipes');
                            onOpenChange(false);
                          }}
                          className="h-7 text-xs gap-1"
                        >
                          <Layers className="size-3" />
                          <span>Recipes</span>
                          <ArrowUpRight className="size-3 text-muted-foreground" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
