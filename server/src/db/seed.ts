/**
 * Idempotent bootstrap seed.
 *
 * Provisions:
 *   1. The five system roles from the shared RBAC catalogue.
 *   2. The full permission catalogue.
 *   3. The role -> permission grants.
 *   4. A super administrator linked to a "root" employee record.
 *
 * Safe to run repeatedly: roles, permissions and grants are upserted, and the
 * admin account is only created if it does not already exist (so re-running
 * never resets a password that an operator has since changed).
 *
 * Usage: npm run seed --workspace server
 */
import { prisma } from './client.js';
import { hashPassword, PasswordPolicyError } from '../auth/password.js';
import { loadEnvFile } from '../lib/env.js';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '@openerp/shared';

loadEnvFile();

async function seedRolesAndPermissions(): Promise<void> {
  for (const role of ROLES) {
    await prisma.appRole.upsert({
      where: { key: role.key },
      update: { name: role.name, description: role.description },
      create: { key: role.key, name: role.name, description: role.description },
    });
  }
  console.log(`  roles          ${ROLES.length} provisioned`);

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { category: permission.category, description: permission.description },
      create: {
        key: permission.key,
        category: permission.category,
        description: permission.description,
      },
    });
  }
  console.log(`  permissions    ${PERMISSIONS.length} provisioned`);

  // Rebuild grants from the catalogue so the matrix always matches code.
  const roles = await prisma.appRole.findMany();
  const permissions = await prisma.permission.findMany();
  const permByKey = new Map(permissions.map((p) => [p.key, p]));

  let grantCount = 0;
  for (const role of roles) {
    const desired = ROLE_PERMISSIONS[role.key] ?? [];
    const desiredIds = desired
      .map((key) => permByKey.get(key))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => p.id);

    const existing = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true },
    });
    const existingIds = new Set(existing.map((r) => r.permissionId));
    const desiredIdSet = new Set(desiredIds);

    const toAdd = desiredIds.filter((id) => !existingIds.has(id));
    const toRemove = [...existingIds].filter((id) => !desiredIdSet.has(id));

    if (toRemove.length) {
      await prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { in: toRemove } },
      });
    }
    if (toAdd.length) {
      await prisma.rolePermission.createMany({
        data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
    }
    grantCount += desiredIds.length;
  }
  console.log(`  grants         ${grantCount} role-permission links synchronised`);
}

async function seedSuperAdmin(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@contractor.co.za').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME ?? 'System';
  const surname = process.env.SEED_ADMIN_SURNAME ?? 'Administrator';

  if (!password) {
    console.warn('  SKIP super admin: SEED_ADMIN_PASSWORD is not set.');
    return;
  }

  const existing = await prisma.appUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`  super admin    already exists (${email}); left untouched`);
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (e) {
    if (e instanceof PasswordPolicyError) {
      throw new Error(
        `SEED_ADMIN_PASSWORD rejected by policy: ${e.message} ` +
          'Use at least 12 characters mixing three of lowercase/uppercase/digit/symbol.',
      );
    }
    throw e;
  }

  // The admin needs an employee record: app_user.employee_id is a 1-to-1
  // non-nullable foreign key, so accounts can never exist without one.
  let contractType = await prisma.employeeContractType.findFirst();
  if (!contractType) {
    contractType = await prisma.employeeContractType.create({
      data: { name: 'Full Time' },
    });
  }

  const employee = await prisma.employee.create({
    data: {
      name,
      surname,
      email,
      startDate: new Date(),
      contractTypeId: contractType.id,
    },
    select: { id: true },
  });

  const adminRole = await prisma.appRole.findUniqueOrThrow({ where: { key: 'administrator' } });

  const user = await prisma.appUser.create({
    data: {
      employeeId: employee.id,
      email,
      passwordHash,
      isActive: true,
      roles: { create: { roleId: adminRole.id } },
    },
    select: { id: true, email: true },
  });

  console.log(`  super admin    created ${user.email} (employee #${employee.id})`);
}

async function main(): Promise<void> {
  console.log('Seeding OpenERP auth + RBAC data...');
  await seedRolesAndPermissions();
  await seedSuperAdmin();
  console.log('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
