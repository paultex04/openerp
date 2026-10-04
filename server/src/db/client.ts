/**
 * Prisma client singleton.
 *
 * Cached on globalThis so `tsx watch` reloads in development reuse one pool
 * instead of leaking a new connection pool on every file change.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
