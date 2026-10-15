/** Contract types provisioned for employee records. */
export const EMPLOYEE_CONTRACT_TYPES = [
  'Monthly Core',
  'Hourly Core',
  'All Inclusive',
  'BCEA',
  'NBCEI',
] as const;

/**
 * Upsert the standard contract types without replacing or deleting existing
 * values. This also makes the catalog available on databases created before
 * these options were added to the application.
 */
export async function seedEmployeeContractTypes(employeeContractType: {
  upsert(args: {
    where: { name: string };
    update: { name: string };
    create: { name: string };
  }): Promise<unknown>;
}): Promise<void> {
  for (const name of EMPLOYEE_CONTRACT_TYPES) {
    await employeeContractType.upsert({
      where: { name },
      update: { name },
      create: { name },
    });
  }
}
