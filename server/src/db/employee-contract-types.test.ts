import { describe, expect, it, vi } from 'vitest';
import { EMPLOYEE_CONTRACT_TYPES, seedEmployeeContractTypes } from './employee-contract-types.js';

describe('seedEmployeeContractTypes', () => {
  it('upserts every standard employee contract type without deleting existing rows', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);

    await seedEmployeeContractTypes({ upsert });

    expect(EMPLOYEE_CONTRACT_TYPES).toEqual([
      'Monthly Core',
      'Hourly Core',
      'All Inclusive',
      'BCEA',
      'NBCEI',
    ]);
    expect(upsert).toHaveBeenCalledTimes(5);
    for (const name of EMPLOYEE_CONTRACT_TYPES) {
      expect(upsert).toHaveBeenCalledWith({
        where: { name },
        update: { name },
        create: { name },
      });
    }
  });

  it('is safe to rerun', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);

    await seedEmployeeContractTypes({ upsert });
    await seedEmployeeContractTypes({ upsert });

    expect(upsert).toHaveBeenCalledTimes(EMPLOYEE_CONTRACT_TYPES.length * 2);
  });
});
