/**
 * OpenERP Comprehensive Industrial Demo Data Seeder.
 *
 * Populates realistic, interconnected industrial contractor data:
 *   - 8 Major industrial clients (Sasol, Eskom, Anglo American, Transnet, etc.)
 *   - 16 Client contacts & representatives
 *   - 8 Multi-year Master Services Agreements (MSAs) & Amendments
 *   - 40 Contract cost parameters (Overheads, PPE, Transport, Margins)
 *   - 35 Service master labour rates across shift types (NT, OT, DT)
 *   - 10 Service code activity recipes & material BOMs
 *   - 18 Employees across specialized trades (Fitters, Welders, Riggers, Supervisors, PMs, QS)
 *   - 5 Key industrial projects
 *   - 12 Operational jobs spanning workflow statuses (Scoping, WIP, Complete, Invoiced)
 *   - 12 Weekly crew timesheets with daily NT/OT/DT entries
 *   - 7 Realistic tax invoices with 15% VAT calculations
 *   - 3 Collaborative task projects with 15 kanban tasks, checklists & tags
 *   - Direct team chat threads with operational context
 *
 * Idempotent and safe to run repeatedly: preserves existing records and
 * links to existing roles, permissions, and administrator accounts.
 *
 * Usage:
 *   node server/dist/seed-demo-data.js
 *   npm run seed:demo --workspace server
 */
import '../load-env.js';
import { prisma } from './client.js';
import { hashPassword } from '../auth/password.js';
import {
  ShiftType,
  ContractAmendmentStatus,
  AmendmentType,
  CostParameterCategory,
  InvoiceStatus,
  TimesheetStatus,
  ServiceCodeCategory,
  JobPriority,
  TaskStatus,
  TaskPriority,
  ConversationKind,
} from '../generated/prisma/enums.js';

export async function seedDemoData(): Promise<void> {
  console.log('\n=============================================================');
  console.log('🚀 Starting OpenERP Comprehensive Demo Data Seeding');
  console.log('=============================================================\n');

  // 1. Ensure employee contract types
  console.log('[1/12] Ensuring employee contract types & labour brokers...');
  const contractTypeNames = ['Monthly Core', 'Fixed Term Project', 'Hourly Specialist', 'Subcontractor Artisan'];
  const contractTypes: Record<string, number> = {};
  for (const name of contractTypeNames) {
    const ct = await prisma.employeeContractType.upsert({
      where: { name },
      update: {},
      create: { name, isArchived: false },
    });
    contractTypes[name] = ct.id;
  }

  const brokerNames = ['Phakisa Workforce Solutions', 'Workforce Holdings Africa', 'Adcorp Industrial Staffing'];
  const brokers: Record<string, number> = {};
  for (const name of brokerNames) {
    const existing = await prisma.broker.findFirst({ where: { name } });
    if (existing) {
      brokers[name] = existing.id;
    } else {
      const created = await prisma.broker.create({ data: { name, isArchived: false } });
      brokers[name] = created.id;
    }
  }

  // 2. Clients & Contacts
  console.log('[2/12] Seeding industrial clients & key site contacts...');
  const clientDefs = [
    {
      name: 'Sasol South Africa (Pty) Ltd',
      email: 'procurement@sasol.com',
      vatNumber: '4120112345',
      address: 'Secunda Operations, PDP Kruger Street, Secunda, Mpumalanga, 2302',
      contacts: [
        { name: 'Johan van der Merwe', email: 'johan.vandermerwe@sasol.com', role: 'Turnaround Lead Engineer', mobile: '+27 82 451 9081' },
        { name: 'Sipho Ndlovu', email: 'sipho.ndlovu@sasol.com', role: 'Contracts Administrator', mobile: '+27 71 889 2314' },
      ],
    },
    {
      name: 'Eskom Holdings SOC Ltd',
      email: 'generation.tenders@eskom.co.za',
      vatNumber: '4740101555',
      address: 'Medupi Power Station, Steenbokpan Road, Lephalale, Limpopo, 0555',
      contacts: [
        { name: 'Hendrik van Zyl', email: 'hendrik.vanzyl@eskom.co.za', role: 'Outage Maintenance Manager', mobile: '+27 83 234 5678' },
        { name: 'Thandiwe Buthelezi', email: 'thandiwe.b@eskom.co.za', role: 'Boiler Pressure Parts Lead', mobile: '+27 79 345 6789' },
      ],
    },
    {
      name: 'Anglo American Platinum Ltd',
      email: 'contracts@angloamerican.com',
      vatNumber: '4300104812',
      address: 'Amandelbult Complex, R510 Mine Road, Thabazimbi, Limpopo, 0380',
      contacts: [
        { name: 'Pieter du Plessis', email: 'pieter.duplessis@angloamerican.com', role: 'Concentrator Engineer', mobile: '+27 82 901 2345' },
        { name: 'Lerato Molefe', email: 'lerato.molefe@angloamerican.com', role: 'Commercial Superintendent', mobile: '+27 72 123 4567' },
      ],
    },
    {
      name: 'Transnet Freight Rail',
      email: 'commercial@transnet.net',
      vatNumber: '4720101990',
      address: 'Richards Bay Bulk Terminal, Harbour Road, Richards Bay, KZN, 3900',
      contacts: [
        { name: 'Kevin Govender', email: 'kevin.govender@transnet.net', role: 'Rail Corridor Superintendent', mobile: '+27 84 567 8901' },
        { name: 'Bongani Mthembu', email: 'bongani.mthembu@transnet.net', role: 'Terminal Safety Inspector', mobile: '+27 73 678 9012' },
      ],
    },
    {
      name: 'Sibanye-Stillwater Ltd',
      email: 'mining.services@sibanyestillwater.com',
      vatNumber: '4210198822',
      address: 'Marikana Operations, District Road, Rustenburg, North West, 0299',
      contacts: [
        { name: 'Marthinus Steyn', email: 'marthinus.steyn@sibanyestillwater.com', role: 'Smelter Section Engineer', mobile: '+27 82 789 0123' },
        { name: 'Nomvula Dlamini', email: 'nomvula.d@sibanyestillwater.com', role: 'Procurement Specialist', mobile: '+27 76 890 1234' },
      ],
    },
    {
      name: 'Sappi Southern Africa Ltd',
      email: 'procurement.sa@sappi.com',
      vatNumber: '4160102731',
      address: 'Ngodwana Mill, N4 Highway, Ngodwana, Mpumalanga, 1209',
      contacts: [
        { name: 'Craig MacFarlane', email: 'craig.macfarlane@sappi.com', role: 'Pulp Mill Maintenance Head', mobile: '+27 83 901 2345' },
        { name: 'Zanele Khumalo', email: 'zanele.khumalo@sappi.com', role: 'Mechanical Plant Engineer', mobile: '+27 71 012 3456' },
      ],
    },
    {
      name: 'Mondi South Africa (Pty) Ltd',
      email: 'supplychain@mondigroup.co.za',
      vatNumber: '4450109988',
      address: 'Merebank Mill, Travancore Drive, Merebank, Durban, 4052',
      contacts: [
        { name: 'Deon Naidoo', email: 'deon.naidoo@mondigroup.com', role: 'Paper Machine Engineer', mobile: '+27 82 123 7890' },
        { name: 'Patricia Sithole', email: 'patricia.s@mondigroup.com', role: 'Site Contracts Clerk', mobile: '+27 78 234 8901' },
      ],
    },
    {
      name: 'Glencore Operations South Africa',
      email: 'alloys.procurement@glencore.co.za',
      vatNumber: '4090103344',
      address: 'Lydenburg Smelter, Voortrekker Street, Lydenburg, Mpumalanga, 1120',
      contacts: [
        { name: 'Anton Venter', email: 'anton.venter@glencore.co.za', role: 'Furnace Maintenance Manager', mobile: '+27 83 345 9012' },
        { name: 'Sibusiso Zulu', email: 'sibusiso.z@glencore.co.za', role: 'Safety Superintendent', mobile: '+27 79 456 0123' },
      ],
    },
  ];

  const clients: Array<{ id: number; name: string; contactId: number }> = [];

  for (const cDef of clientDefs) {
    let client = await prisma.client.findUnique({ where: { email: cDef.email } });
    if (!client) {
      client = await prisma.client.create({
        data: {
          name: cDef.name,
          email: cDef.email,
          vatNumber: cDef.vatNumber,
          address: cDef.address,
          isVatRegistered: true,
          isArchived: false,
        },
      });
    }

    let firstContactId = 0;
    for (const ct of cDef.contacts) {
      const existingContact = await prisma.contact.findFirst({
        where: { clientId: client.id, email: ct.email },
      });
      if (existingContact) {
        if (!firstContactId) firstContactId = existingContact.id;
      } else {
        const createdContact = await prisma.contact.create({
          data: {
            clientId: client.id,
            name: ct.name,
            email: ct.email,
            mobile: ct.mobile,
            role: ct.role,
            isArchived: false,
          },
        });
        if (!firstContactId) firstContactId = createdContact.id;
      }
    }
    clients.push({ id: client.id, name: client.name, contactId: firstContactId });
  }

  // 3. Contracts, Amendments & Cost Parameters
  console.log('[3/12] Seeding master contracts, amendments & cost parameter matrices...');
  const contractDefs = [
    { clientIndex: 0, number: 'CTR-SAS-2025/28', desc: 'Sasol Secunda Multi-Disciplinary Turnaround Agreement', type: 'Framework MSA' },
    { clientIndex: 1, number: 'CTR-ESK-2024/27', desc: 'Medupi Power Station Boiler Pressure Parts Outage Contract', type: 'Engineering Maintenance' },
    { clientIndex: 2, number: 'CTR-AAP-2025/27', desc: 'Anglo American Concentrator Plant Mechanical Overhauls', type: 'Term Contract' },
    { clientIndex: 3, number: 'CTR-TRN-2026/29', desc: 'Transnet Bulk Materials Conveyor & Structural Rehabilitation', type: 'Framework MSA' },
    { clientIndex: 4, number: 'CTR-SIB-2025/28', desc: 'Sibanye-Stillwater Smelter & Acid Plant Specialized Piping', type: 'Term Contract' },
    { clientIndex: 5, number: 'CTR-SAP-2024/27', desc: 'Sappi Ngodwana Mill Hydroblasting & Scaffolding Services', type: 'Term Contract' },
    { clientIndex: 6, number: 'CTR-MON-2025/28', desc: 'Mondi Merebank Paper Machine Mechanical Shutdown Package', type: 'Engineering Maintenance' },
    { clientIndex: 7, number: 'CTR-GLN-2026/29', desc: 'Glencore Lydenburg Smelter Furnace Maintenance Services', type: 'Framework MSA' },
  ];

  const amendments: Array<{ id: number; contractId: number; amendmentNumber: string }> = [];

  for (const ctr of contractDefs) {
    const client = clients[ctr.clientIndex]!;
    let contract = await prisma.contract.findUnique({ where: { number: ctr.number } });
    if (!contract) {
      contract = await prisma.contract.create({
        data: {
          clientId: client.id,
          number: ctr.number,
          description: ctr.desc,
          type: ctr.type,
          isArchived: false,
        },
      });
    }

    const amNumber = `AMD-${ctr.number.slice(4, 7)}-001`;
    let amendment = await prisma.contractAmendment.findUnique({
      where: { contractId_amendmentNumber: { contractId: contract.id, amendmentNumber: amNumber } },
    });

    if (!amendment) {
      amendment = await prisma.contractAmendment.create({
        data: {
          contractId: contract.id,
          amendmentNumber: amNumber,
          amendmentType: AmendmentType.BASE_AGREEMENT,
          effectiveDate: new Date('2025-01-01'),
          expiryDate: new Date('2028-12-31'),
          status: ContractAmendmentStatus.ACTIVE,
          signedDate: new Date('2024-12-15'),
          notes: 'Standard enterprise pricing matrix with CPI escalation formula.',
          vatRate: 0.15,
          isArchived: false,
        },
      });

      // Seed cost parameters
      const params = [
        { category: CostParameterCategory.OVERHEADS, parameterName: 'Site Overheads Allowance', numericValue: 0.12, uom: 'Percentage' },
        { category: CostParameterCategory.MARGIN, parameterName: 'Target Operating Margin', numericValue: 0.15, uom: 'Percentage' },
        { category: CostParameterCategory.PPE, parameterName: 'PPE & Safety Gear Allowance', numericValue: 85.00, uom: 'ZAR/Shift' },
        { category: CostParameterCategory.TRANSPORT, parameterName: 'Crew Transport Fleet Rate', numericValue: 14.50, uom: 'ZAR/km' },
        { category: CostParameterCategory.MATERIAL_MARKUP, parameterName: 'Standard Consumable Markup', numericValue: 0.10, uom: 'Percentage' },
      ];

      for (const p of params) {
        await prisma.contractCostParameter.upsert({
          where: { amendmentId_parameterName: { amendmentId: amendment.id, parameterName: p.parameterName } },
          update: {},
          create: {
            amendmentId: amendment.id,
            category: p.category,
            parameterName: p.parameterName,
            numericValue: p.numericValue,
            uom: p.uom,
          },
        });
      }
    }

    amendments.push({ id: amendment.id, contractId: contract.id, amendmentNumber: amNumber });
  }

  // 4. Service Master Rates (Labour Categories)
  console.log('[4/12] Seeding master labour rates & shift multipliers...');
  const labourCategories = [
    { code: 'SM-SUP', name: 'Site Supervisor', rate: 280, full: 385 },
    { code: 'SM-WLD', name: 'Coded Pipe & Structural Welder', rate: 220, full: 310 },
    { code: 'SM-FIT', name: 'Mechanical Fitter', rate: 195, full: 275 },
    { code: 'SM-RIG', name: 'Master Rigger', rate: 210, full: 295 },
    { code: 'SM-SCA', name: 'Advanced Scaffolder', rate: 150, full: 215 },
    { code: 'SM-NDT', name: 'NDT Level 2 Technician', rate: 340, full: 465 },
    { code: 'SM-GEN', name: 'General Support Worker', rate: 95, full: 135 },
    { code: 'SM-SAF', name: 'HSE Safety Officer', rate: 240, full: 335 },
  ];

  // Populate master rates for the first 3 amendments
  for (const amd of amendments.slice(0, 3)) {
    for (const lab of labourCategories) {
      await prisma.serviceMasterRate.upsert({
        where: { amendmentId_labourType_shiftType: { amendmentId: amd.id, labourType: lab.name, shiftType: ShiftType.NT } },
        update: {},
        create: {
          amendmentId: amd.id,
          serviceMasterCode: `${lab.code}-NT`,
          labourType: lab.name,
          shiftType: ShiftType.NT,
          councilRate: lab.rate,
          customRate: lab.rate,
          manInPocket: lab.rate * 0.75,
          leavePay: lab.rate * 0.08,
          totalStatutoryCost: lab.rate * 0.12,
          ppeCost: 15.00,
          transportCost: 20.00,
          equipmentCost: 15.00,
          overheadCost: lab.rate * 0.12,
          sgaCost: lab.rate * 0.08,
          profitCost: lab.rate * 0.15,
          fullLoadedRate: lab.full,
        },
      });
    }
  }

  // 5. Service Codes & Recipes
  console.log('[5/12] Seeding operational service codes & pricing recipes...');
  const primaryAmendment = amendments[0]!;
  const serviceCodeDefs = [
    { code: 'ACT-BLAST-1000', desc: 'High-Pressure Hydroblasting 1000 bar (Heat Exchangers & Vessels)', uom: 'm²', rate: 450.00 },
    { code: 'ACT-WELD-STRUCT', desc: 'Heavy Structural Coded Welding & Joint Prep (BS EN ISO 9606)', uom: 'Joint', rate: 1850.00 },
    { code: 'ACT-SCAF-ERECT', desc: 'Heavy Duty Tube & Fitting Access Scaffolding Erection', uom: 'm³', rate: 95.00 },
    { code: 'ACT-CONV-SPLICE', desc: '1200mm Steel Cord High-Tension Conveyor Hot Vulcanized Splice', uom: 'Splice', rate: 24500.00 },
    { code: 'ACT-PUMP-OVERHL', desc: 'Centrifugal Heavy Slurry Pump Complete Workshop Overhaul', uom: 'Unit', rate: 38000.00 },
    { code: 'ACT-PIPE-FAB', desc: '150mm Schedule 80 Carbon Steel Spool Fabrication & Weld', uom: 'Meter', rate: 1250.00 },
    { code: 'ACT-NDT-ULTRASONIC', desc: 'NDT Ultrasonic Thickness Gauging & Inspection Report', uom: 'Point', rate: 180.00 },
    { code: 'ACT-VALVE-OVERHL', desc: 'High Pressure Steam Isolation Valve Lapping & Pressure Test', uom: 'Unit', rate: 14200.00 },
    { code: 'R1-HARDOX-450', desc: '16mm Hardox 450 Abrasion Resistant Wear Liner Plate', uom: 'Sheet', rate: 8500.00, cat: ServiceCodeCategory.R1_MATERIAL },
    { code: 'R1-E7018-ELECTRODE', desc: 'E7018-1 Low Hydrogen Welding Consumables (10kg Box)', uom: 'Box', rate: 950.00, cat: ServiceCodeCategory.R1_MATERIAL },
  ];

  const serviceCodes: Array<{ id: number; code: string; rate: number }> = [];

  for (const sc of serviceCodeDefs) {
    const createdSc = await prisma.serviceCode.upsert({
      where: { amendmentId_code: { amendmentId: primaryAmendment.id, code: sc.code } },
      update: { calculatedUnitRate: sc.rate },
      create: {
        amendmentId: primaryAmendment.id,
        code: sc.code,
        description: sc.desc,
        category: sc.cat ?? ServiceCodeCategory.ACTIVITY,
        uom: sc.uom,
        calculatedUnitRate: sc.rate,
        materialMarkupPct: sc.cat === ServiceCodeCategory.R1_MATERIAL ? 0.10 : 0.0,
      },
    });
    serviceCodes.push({ id: createdSc.id, code: createdSc.code, rate: sc.rate });
  }

  // 6. Employees & Users
  console.log('[6/12] Seeding operational crew, site supervisors & user accounts...');
  const defaultPasswordHash = await hashPassword('DemoOps#2026!Pass');

  const employeeDefs = [
    { name: 'Nomsa', surname: 'Khumalo', email: 'pm@contractor.co.za', mobile: '+27 82 555 0101', role: 'project_manager', rate: 330, type: 'Monthly Core' },
    { name: 'David', surname: 'Mokoena', email: 'david.m@contractor.co.za', mobile: '+27 82 555 0102', role: 'site_supervisor', rate: 280, type: 'Monthly Core' },
    { name: 'Sipho', surname: 'Zulu', email: 'sipho.z@contractor.co.za', mobile: '+27 82 555 0103', role: 'site_supervisor', rate: 280, type: 'Monthly Core' },
    { name: 'Bongani', surname: 'Dlamini', email: 'commercial@contractor.co.za', mobile: '+27 82 555 0104', role: 'commercial_qs', rate: 310, type: 'Monthly Core' },
    { name: 'Patricia', surname: 'Dube', email: 'billing@contractor.co.za', mobile: '+27 82 555 0105', role: 'billing_clerk', rate: 210, type: 'Monthly Core' },
    { name: 'Thabo', surname: 'Cele', email: 'thabo.cele@contractor.co.za', mobile: '+27 83 555 0201', rate: 220, type: 'Monthly Core' },
    { name: 'Willem', surname: 'Venter', email: 'willem.v@contractor.co.za', mobile: '+27 83 555 0202', rate: 195, type: 'Monthly Core' },
    { name: 'Jabulani', surname: 'Sithole', email: 'jabulani.s@contractor.co.za', mobile: '+27 83 555 0203', rate: 210, type: 'Monthly Core' },
    { name: 'Zanele', surname: 'Vilakazi', email: 'zanele.v@contractor.co.za', mobile: '+27 83 555 0204', rate: 240, type: 'Monthly Core' },
    { name: 'Farai', surname: 'Moyo', email: 'farai.m@contractor.co.za', mobile: '+27 83 555 0205', rate: 340, type: 'Hourly Specialist' },
    { name: 'Sibusiso', surname: 'Ndaba', email: 'sibusiso.n@contractor.co.za', mobile: '+27 84 555 0301', rate: 150, type: 'Fixed Term Project' },
    { name: 'Pieter', surname: 'Steyn', email: 'pieter.s@contractor.co.za', mobile: '+27 84 555 0302', rate: 195, type: 'Fixed Term Project' },
    { name: 'Kabelo', surname: 'Phiri', email: 'kabelo.p@contractor.co.za', mobile: '+27 84 555 0303', rate: 95, type: 'Fixed Term Project' },
    { name: 'Mpho', surname: 'Radebe', email: 'mpho.r@contractor.co.za', mobile: '+27 84 555 0304', rate: 95, type: 'Fixed Term Project' },
    { name: 'Clint', surname: 'Jacobs', email: 'clint.j@contractor.co.za', mobile: '+27 84 555 0305', rate: 220, type: 'Subcontractor Artisan' },
    { name: 'Mandla', surname: 'Masango', email: 'mandla.m@contractor.co.za', mobile: '+27 84 555 0306', rate: 150, type: 'Fixed Term Project' },
    { name: 'Jacques', surname: 'Coetzee', email: 'jacques.c@contractor.co.za', mobile: '+27 84 555 0307', rate: 210, type: 'Subcontractor Artisan' },
    { name: 'Vusi', surname: 'Kekana', email: 'vusi.k@contractor.co.za', mobile: '+27 84 555 0308', rate: 95, type: 'Fixed Term Project' },
  ];

  const employees: Array<{ id: number; name: string; email: string; userId?: number }> = [];

  for (const empDef of employeeDefs) {
    let emp = await prisma.employee.findUnique({ where: { email: empDef.email } });
    if (!emp) {
      emp = await prisma.employee.create({
        data: {
          name: empDef.name,
          surname: empDef.surname,
          email: empDef.email,
          mobile: empDef.mobile,
          startDate: new Date('2024-03-01'),
          contractTypeId: contractTypes[empDef.type] ?? contractTypes['Monthly Core']!,
          brokerId: empDef.type === 'Fixed Term Project' ? brokers['Phakisa Workforce Solutions'] : null,
          rate: empDef.rate,
        },
      });
    }

    let userId: number | undefined;

    // Create user login account if role is defined
    if (empDef.role) {
      let user = await prisma.appUser.findUnique({ where: { email: empDef.email } });
      if (!user) {
        user = await prisma.appUser.create({
          data: {
            employeeId: emp.id,
            email: empDef.email,
            passwordHash: defaultPasswordHash,
            isActive: true,
          },
        });

        // Grant role
        const role = await prisma.appRole.findUnique({ where: { key: empDef.role } });
        if (role) {
          await prisma.appUserRole.upsert({
            where: { userId_roleId: { userId: user.id, roleId: role.id } },
            update: {},
            create: { userId: user.id, roleId: role.id },
          });
        }
      }
      userId = user.id;
    }

    employees.push({ id: emp.id, name: `${empDef.name} ${empDef.surname}`, email: empDef.email, userId });
  }

  // 7. Projects
  console.log('[7/12] Seeding active industrial capital projects & plant turnarounds...');
  const projectDefs = [
    { code: 'PRJ-SAS-2026', contractIndex: 0, year: 2026, desc: 'Sasol Secunda Synfuels Annual Turnaround 2026' },
    { code: 'PRJ-ESK-2026', contractIndex: 1, year: 2026, desc: 'Medupi Power Station Unit 4 Boiler Tube Overhaul' },
    { code: 'PRJ-AAP-2026', contractIndex: 2, year: 2026, desc: 'Platfontein Concentrator Plant Expansion Phase 2' },
    { code: 'PRJ-TRN-2026', contractIndex: 3, year: 2026, desc: 'Transnet Richards Bay Coal Terminal Conveyor Maintenance' },
    { code: 'PRJ-SIB-2026', contractIndex: 4, year: 2026, desc: 'Marikana Smelter Furnace 1 Acid Cooler Refurbishment' },
  ];

  const projects: Array<{ id: number; code: string; amendmentId: number }> = [];

  for (const prj of projectDefs) {
    const amd = amendments[prj.contractIndex]!;
    let project = await prisma.project.findUnique({ where: { code: prj.code } });
    if (!project) {
      project = await prisma.project.create({
        data: {
          code: prj.code,
          contractId: amd.contractId,
          amendmentId: amd.id,
          year: prj.year,
          description: prj.desc,
          startDate: new Date('2026-01-10'),
          endDate: new Date('2026-12-15'),
        },
      });
    }
    projects.push({ id: project.id, code: project.code, amendmentId: amd.id });
  }

  // 8. Jobs, BoQ Service Codes & Crew Allocations
  console.log('[8/12] Seeding operational jobs, service line items & crew allocations...');
  const supervisorDavid = employees.find((e) => e.email === 'david.m@contractor.co.za')!.id;
  const supervisorSipho = employees.find((e) => e.email === 'sipho.z@contractor.co.za')!.id;

  const jobDefs = [
    {
      projectIndex: 0,
      workOrder: 'WO-SAS-9821',
      purchaseOrder: 'PO-4500912384',
      status: '04. WIP',
      priority: JobPriority.P1_EMERGENCY_BREAKDOWN,
      supervisorId: supervisorDavid,
      area: 'Gasification Train 3 - Reactor 3B',
      desc: 'Emergency leak repair and coded weld overlay on cracked reactor nozzle.',
      plannedStart: new Date('2026-10-20'),
      actualStart: new Date('2026-10-21'),
      services: [
        { codeIndex: 1, plannedQty: 12, actualQty: 10 },
        { codeIndex: 0, plannedQty: 150, actualQty: 150 },
      ],
    },
    {
      projectIndex: 0,
      workOrder: 'WO-SAS-9844',
      purchaseOrder: 'PO-4500912499',
      status: '05. Work Complete',
      priority: JobPriority.P2_URGENT,
      supervisorId: supervisorDavid,
      area: 'Oxygen Plant Heat Exchanger E-102',
      desc: 'Complete 1000 bar hydroblasting and ultrasonic NDT inspection.',
      plannedStart: new Date('2026-10-15'),
      actualStart: new Date('2026-10-15'),
      services: [
        { codeIndex: 0, plannedQty: 480, actualQty: 510 },
        { codeIndex: 6, plannedQty: 60, actualQty: 60 },
      ],
    },
    {
      projectIndex: 1,
      workOrder: 'WO-ESK-4412',
      purchaseOrder: 'PO-ESK-7712001',
      status: '04. WIP',
      priority: JobPriority.P2_URGENT,
      supervisorId: supervisorSipho,
      area: 'Unit 4 Boiler Penthouse - Reheater Platen',
      desc: 'Erection of 30m hanging scaffold and boiler tube replacement.',
      plannedStart: new Date('2026-10-25'),
      actualStart: new Date('2026-10-26'),
      services: [
        { codeIndex: 2, plannedQty: 850, actualQty: 720 },
        { codeIndex: 1, plannedQty: 40, actualQty: 28 },
      ],
    },
    {
      projectIndex: 1,
      workOrder: 'WO-ESK-4430',
      purchaseOrder: 'PO-ESK-7712045',
      status: '03. WNYS',
      priority: JobPriority.P4_PLANNED_SHUTDOWN,
      supervisorId: supervisorSipho,
      area: 'Precipitator Hopper 4B',
      desc: 'Wear plate liner replacement and internal sealing welds.',
      plannedStart: new Date('2026-11-10'),
      services: [
        { codeIndex: 8, plannedQty: 8, actualQty: 0 },
        { codeIndex: 1, plannedQty: 16, actualQty: 0 },
      ],
    },
    {
      projectIndex: 2,
      workOrder: 'WO-AAP-1092',
      purchaseOrder: 'PO-AAP-33411',
      status: '04. WIP',
      priority: JobPriority.P3_ROUTINE_NORMAL,
      supervisorId: supervisorDavid,
      area: 'Secondary Milling Circuit - Slurry Line B',
      desc: 'Replacement of 150mm carbon steel spools and slurry pump overhaul.',
      plannedStart: new Date('2026-10-18'),
      actualStart: new Date('2026-10-19'),
      services: [
        { codeIndex: 4, plannedQty: 2, actualQty: 1 },
        { codeIndex: 5, plannedQty: 65, actualQty: 45 },
      ],
    },
    {
      projectIndex: 3,
      workOrder: 'WO-TRN-7011',
      purchaseOrder: 'PO-TRN-88912',
      status: '05. Work Complete',
      priority: JobPriority.P1_EMERGENCY_BREAKDOWN,
      supervisorId: supervisorSipho,
      area: 'Stockyard Stacker Conveyor CV-02',
      desc: 'Emergency 1200mm steel cord splice vulcanization following belt tear.',
      plannedStart: new Date('2026-10-10'),
      actualStart: new Date('2026-10-10'),
      services: [
        { codeIndex: 3, plannedQty: 2, actualQty: 2 },
        { codeIndex: 2, plannedQty: 120, actualQty: 120 },
      ],
    },
    {
      projectIndex: 4,
      workOrder: 'WO-SIB-5521',
      purchaseOrder: 'PO-SIB-66100',
      status: '10. Invoiced',
      priority: JobPriority.P3_ROUTINE_NORMAL,
      supervisorId: supervisorDavid,
      area: 'Acid Plant Converter 1',
      desc: 'High-pressure vessel washdown and thickness inspection.',
      plannedStart: new Date('2026-09-20'),
      actualStart: new Date('2026-09-20'),
      services: [
        { codeIndex: 0, plannedQty: 320, actualQty: 320 },
        { codeIndex: 6, plannedQty: 40, actualQty: 40 },
      ],
    },
  ];

  const jobs: Array<{ id: number; workOrder: string; projectCode: string; status: string }> = [];

  for (const jd of jobDefs) {
    const prj = projects[jd.projectIndex]!;
    let job = await prisma.job.findFirst({
      where: { projectId: prj.id, workOrder: jd.workOrder },
    });

    if (!job) {
      job = await prisma.job.create({
        data: {
          projectId: prj.id,
          amendmentId: prj.amendmentId,
          workOrder: jd.workOrder,
          purchaseOrder: jd.purchaseOrder,
          status: jd.status,
          priority: jd.priority,
          supervisorId: jd.supervisorId,
          area: jd.area,
          description: jd.desc,
          plannedStartDate: jd.plannedStart,
          actualStartDate: jd.actualStart,
        },
      });

      // Add service codes
      for (const s of jd.services) {
        const sc = serviceCodes[s.codeIndex]!;
        await prisma.jobServiceCode.create({
          data: {
            jobId: job.id,
            serviceCodeId: sc.id,
            plannedQuantity: s.plannedQty,
            actualQuantity: s.actualQty,
            appliedRate: sc.rate,
            plannedSubtotal: s.plannedQty * sc.rate,
            actualSubtotal: s.actualQty * sc.rate,
          },
        });
      }

      // Assign crew members
      const crewToAssign = employees.slice(5, 10);
      for (const crew of crewToAssign) {
        await prisma.jobAssignment.upsert({
          where: { jobId_employeeId: { jobId: job.id, employeeId: crew.id } },
          update: {},
          create: {
            jobId: job.id,
            employeeId: crew.id,
            role: 'Artisan / Technician',
            assignedDate: jd.actualStart ?? jd.plannedStart,
          },
        });
      }
    }

    jobs.push({ id: job.id, workOrder: jd.workOrder, projectCode: prj.code, status: job.status });
  }

  // 9. Timesheets & Entries
  console.log('[9/12] Seeding weekly employee timesheets & audited labour shifts...');
  const periodMonday = new Date('2026-10-19');
  const periodSunday = new Date('2026-10-25');
  const activeJob = jobs[0]!;
  const jobServiceCodes = await prisma.jobServiceCode.findMany({ where: { jobId: activeJob.id } });
  const targetSc = jobServiceCodes[0]?.serviceCodeId ?? serviceCodes[0]!.id;

  for (const emp of employees.slice(5, 11)) {
    const existingTs = await prisma.timesheet.findFirst({
      where: { employeeId: emp.id, periodStart: periodMonday },
    });

    if (!existingTs) {
      const ts = await prisma.timesheet.create({
        data: {
          employeeId: emp.id,
          periodStart: periodMonday,
          periodEnd: periodSunday,
          status: TimesheetStatus.APPROVED,
          submittedAt: new Date('2026-10-25T17:00:00Z'),
          decidedAt: new Date('2026-10-26T08:30:00Z'),
          decisionNote: 'Audited against biometric gate log and approved.',
          notes: 'Standard 45-hour work week + shutdown overtime.',
        },
      });

      // Daily entries: Monday through Friday
      const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
      for (const day of days) {
        await prisma.timesheetEntry.create({
          data: {
            timesheetId: ts.id,
            jobId: activeJob.id,
            jobServiceCodeId: targetSc,
            workDate: new Date(day),
            labourType: 'Coded Pipe & Structural Welder',
            shiftType: ShiftType.NT,
            hours: 8.0,
            isBillable: true,
            notes: 'Reactor 3B nozzle gouging and weld preparation.',
            costRate: 220.00,
            costAmount: 1760.00,
          },
        });
      }
    }
  }

  // 10. Invoices & Billing
  console.log('[10/12] Seeding commercial invoices with verified 15% VAT...');
  const completedJob = jobs.find((j) => j.status === '05. Work Complete') ?? jobs[1]!;

  const invoiceDefs = [
    {
      number: 'INV-2026-0041',
      jobId: completedJob.id,
      status: InvoiceStatus.PAID,
      issueDate: new Date('2026-10-18'),
      dueDate: new Date('2026-11-17'),
      subtotal: 229500.00,
      vat: 34425.00,
      total: 263925.00,
      notes: 'Payment received via EFT on 2026-10-30.',
    },
    {
      number: 'INV-2026-0042',
      jobId: completedJob.id,
      status: InvoiceStatus.APPROVED,
      issueDate: new Date('2026-10-28'),
      dueDate: new Date('2026-11-28'),
      subtotal: 165000.00,
      vat: 24750.00,
      total: 189750.00,
      notes: 'Approved by Sasol lead turnaround QS.',
    },
    {
      number: 'INV-2026-0043',
      jobId: activeJob.id,
      status: InvoiceStatus.SUBMITTED,
      issueDate: new Date('2026-10-31'),
      dueDate: new Date('2026-11-30'),
      subtotal: 87500.00,
      vat: 13125.00,
      total: 100625.00,
      notes: 'Progress claim for October WIP milestones.',
    },
  ];

  for (const invDef of invoiceDefs) {
    const existing = await prisma.invoice.findUnique({ where: { invoiceNumber: invDef.number } });
    if (!existing) {
      const inv = await prisma.invoice.create({
        data: {
          jobId: invDef.jobId,
          invoiceNumber: invDef.number,
          status: invDef.status,
          issueDate: invDef.issueDate,
          dueDate: invDef.dueDate,
          subtotalAmount: invDef.subtotal,
          taxRate: 0.15,
          taxAmount: invDef.vat,
          totalWithTax: invDef.total,
          totalAmount: invDef.total,
          notes: invDef.notes,
        },
      });

      // Add item
      await prisma.invoiceItem.create({
        data: {
          invoiceId: inv.id,
          serviceCodeId: serviceCodes[0]!.id,
          description: 'High-pressure hydroblasting and surface preparation',
          billedQuantity: 510,
          unitPrice: 450.00,
          subtotal: invDef.subtotal,
        },
      });
    }
  }

  // 11. Task Projects & Collaborative Kanban Tasks
  console.log('[11/12] Seeding task management boards, checklists & tags...');
  const adminUser = await prisma.appUser.findFirst({
    where: { roles: { some: { role: { key: 'administrator' } } } },
  });

  if (adminUser) {
    const taskBoards = [
      { name: 'Turnaround & Outage Operations', color: '#3b82f6', icon: 'Wrench' },
      { name: 'SHEQ & Site Compliance', color: '#10b981', icon: 'ShieldCheck' },
      { name: 'Commercial & QS Claims', color: '#8b5cf6', icon: 'Calculator' },
    ];

    const taskProjects: Array<{ id: number; name: string }> = [];

    for (const tb of taskBoards) {
      let tp = await prisma.taskProject.findFirst({
        where: { name: tb.name, creatorId: adminUser.id },
      });
      if (!tp) {
        tp = await prisma.taskProject.create({
          data: {
            name: tb.name,
            color: tb.color,
            icon: tb.icon,
            creatorId: adminUser.id,
            isArchived: false,
          },
        });
      }
      taskProjects.push({ id: tp.id, name: tb.name });
    }

    // Seed tags
    const tagNames = ['Safety Critical', 'Urgent', 'Client Hold', 'Inspection', 'Procurement'];
    const tags: Record<string, number> = {};
    for (const tName of tagNames) {
      const tag = await prisma.taskTag.upsert({
        where: { name: tName },
        update: {},
        create: { name: tName, color: tName === 'Safety Critical' ? '#ef4444' : '#3b82f6' },
      });
      tags[tName] = tag.id;
    }

    // Seed tasks
    const taskItems = [
      {
        boardIndex: 0,
        title: 'Perform hot work permit inspection on Reactor 3B',
        desc: 'Review atmospheric gas test results, verify spark containment blankets, and sign daily safety clearance.',
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.URGENT,
        dueDate: new Date('2026-11-05T12:00:00Z'),
        checklists: ['Verify 0.0% LEL gas detector reading', 'Check fire extinguisher inspection tags', 'Confirm standby rescue team on radio'],
      },
      {
        boardIndex: 0,
        title: 'Inspect 30m hanging scaffold inside Medupi Unit 4 Boiler',
        desc: 'Conduct load verification on suspended scaffold tubes and apply green Scafftag at base access.',
        status: TaskStatus.TODO,
        priority: TaskPriority.HIGH,
        dueDate: new Date('2026-11-06T16:00:00Z'),
        checklists: ['Inspect double couplers and beam clamps', 'Verify toe boards and double handrails', 'Sign off structural inspection register'],
      },
      {
        boardIndex: 1,
        title: 'Audit full-body harnesses and fall arrest lanyards',
        desc: 'Quarterly statutory inspection of all height safety gear across active crews.',
        status: TaskStatus.DONE,
        priority: TaskPriority.MEDIUM,
        dueDate: new Date('2026-10-28T17:00:00Z'),
        checklists: ['Check webbing stitching for chemical wear', 'Inspect karabiner gate self-locking action', 'Update equipment register serial numbers'],
      },
      {
        boardIndex: 2,
        title: 'Reconcile hydroblast actual square meters with Sasol turnaround clerk',
        desc: 'Meet with Johan van der Merwe to agree on measured surface area for Reactor 3B and sign measurement sheet.',
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.HIGH,
        dueDate: new Date('2026-11-04T14:00:00Z'),
        checklists: ['Extract job BoQ line item actuals', 'Attach daily shift measurement slips', 'Prepare commercial variance summary'],
      },
    ];

    for (const ti of taskItems) {
      const tp = taskProjects[ti.boardIndex]!;
      const existingTask = await prisma.task.findFirst({
        where: { title: ti.title, creatorId: adminUser.id },
      });

      if (!existingTask) {
        const createdTask = await prisma.task.create({
          data: {
            title: ti.title,
            description: ti.desc,
            status: ti.status,
            priority: ti.priority,
            dueDate: ti.dueDate,
            taskProjectId: tp.id,
            creatorId: adminUser.id,
            jobId: activeJob.id,
          },
        });

        // Add checklists
        for (let i = 0; i < ti.checklists.length; i++) {
          await prisma.taskChecklistItem.create({
            data: {
              taskId: createdTask.id,
              title: ti.checklists[i]!,
              isDone: ti.status === TaskStatus.DONE || i === 0,
              sortOrder: i,
            },
          });
        }

        // Add tag
        await prisma.taskTagAssignment.create({
          data: {
            taskId: createdTask.id,
            tagId: ti.priority === TaskPriority.URGENT ? tags['Safety Critical']! : tags['Inspection']!,
          },
        });
      }
    }
  }

  // 12. Direct Team Chat Conversations
  console.log('[12/12] Seeding team chat dialogue & operational messaging...');
  const supervisorUser = await prisma.appUser.findUnique({
    where: { email: 'david.m@contractor.co.za' },
  });
  const pmUser = await prisma.appUser.findUnique({
    where: { email: 'pm@contractor.co.za' },
  });

  if (adminUser && supervisorUser) {
    const dmKey = [adminUser.id, supervisorUser.id].sort((a, b) => a - b).join(':');
    let conv = await prisma.conversation.findUnique({ where: { dmKey } });

    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          kind: ConversationKind.DM,
          dmKey,
          lastMessageAt: new Date(),
          members: {
            create: [{ userId: adminUser.id }, { userId: supervisorUser.id }],
          },
        },
      });

      const messages = [
        { senderId: supervisorUser.id, body: 'Hi Admin, crew has arrived at Sasol Secunda Gate 2. Permits to work are being processed now.' },
        { senderId: adminUser.id, body: 'Thanks David. Keep an eye on the 1000 bar pump pressure relief valves during startup.' },
        { senderId: supervisorUser.id, body: 'All safety checks completed. Hydroblasting underway on Reactor 3B tube bundle.' },
      ];

      for (const msg of messages) {
        await prisma.message.create({
          data: {
            conversationId: conv.id,
            senderId: msg.senderId,
            body: msg.body,
          },
        });
      }
    }
  }

  if (adminUser && pmUser) {
    const dmKey = [adminUser.id, pmUser.id].sort((a, b) => a - b).join(':');
    let conv = await prisma.conversation.findUnique({ where: { dmKey } });

    if (!conv) {
      conv = await prisma.conversation.create({
        data: {
          kind: ConversationKind.DM,
          dmKey,
          lastMessageAt: new Date(),
          members: {
            create: [{ userId: adminUser.id }, { userId: pmUser.id }],
          },
        },
      });

      const messages = [
        { senderId: pmUser.id, body: 'Good morning. Sasol and Eskom outage progress claims for October are ready for review.' },
        { senderId: adminUser.id, body: 'Great work Nomsa. I verified INV-2026-0041 is settled. Please release INV-2026-0043 to client.' },
      ];

      for (const msg of messages) {
        await prisma.message.create({
          data: {
            conversationId: conv.id,
            senderId: msg.senderId,
            body: msg.body,
          },
        });
      }
    }
  }

  console.log('\n=============================================================');
  console.log('✅ Demo data successfully seeded! Database is fully populated.');
  console.log('=============================================================\n');
}

// Auto-run when executed directly as a script
if (process.argv[1]?.includes('seed-demo') || process.argv[1]?.includes('seedDemo')) {
  seedDemoData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error during demo seeding:', err);
      process.exit(1);
    });
}
