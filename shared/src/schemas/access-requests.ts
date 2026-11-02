import { z } from 'zod';
import type { AccessRequestStatus } from './enums';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('A valid email address is required.')
  .max(255);

export const createAccessRequestSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, 'Full name must be at least 2 characters.')
    .max(150, 'Full name must not exceed 150 characters.'),
  email: emailSchema,
  phone: z
    .string()
    .trim()
    .min(5, 'Phone number must be at least 5 characters.')
    .max(50, 'Phone number must not exceed 50 characters.'),
  department: z
    .string()
    .trim()
    .min(2, 'Department / trade must be at least 2 characters.')
    .max(100, 'Department must not exceed 100 characters.'),
  jobTitle: z
    .string()
    .trim()
    .max(100, 'Job title must not exceed 100 characters.')
    .optional()
    .nullable(),
  reason: z
    .string()
    .trim()
    .min(10, 'Please provide a business justification (at least 10 characters).')
    .max(2000, 'Justification must not exceed 2000 characters.'),
});

export type CreateAccessRequestInput = z.infer<typeof createAccessRequestSchema>;

export const approveAccessRequestSchema = z.object({
  roleKeys: z.array(z.string().trim().min(1)).min(1, 'Assign at least one role to the new user.'),
  temporaryPassword: z
    .string()
    .min(8, 'Temporary password must be at least 8 characters.')
    .max(128)
    .optional(),
  contractTypeId: z.coerce.number().int().positive().optional(),
  rate: z.coerce
    .number()
    .positive('An hourly rate must be positive.')
    .max(100_000, 'Hourly rate is implausibly high.')
    .optional(),
  adminNotes: z.string().trim().max(2000).optional().nullable(),
});

export type ApproveAccessRequestInput = z.infer<typeof approveAccessRequestSchema>;

export const rejectAccessRequestSchema = z.object({
  adminNotes: z
    .string()
    .trim()
    .min(3, 'Please provide feedback or a reason for declining.')
    .max(2000, 'Notes must not exceed 2000 characters.'),
});

export type RejectAccessRequestInput = z.infer<typeof rejectAccessRequestSchema>;

export interface AccessRequestRow {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  department: string | null;
  jobTitle: string | null;
  reason: string;
  status: AccessRequestStatus;
  adminNotes: string | null;
  reviewedById: number | null;
  reviewedAt: string | null;
  createdUserId: number | null;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: {
    id: number;
    email: string;
    name: string;
  } | null;
  createdUser?: {
    id: number;
    email: string;
  } | null;
}

export interface AccessRequestStatusResponse {
  found: boolean;
  request?: AccessRequestRow | null;
}
