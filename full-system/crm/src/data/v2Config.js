/**
 * PHASE 8 — V2 Configuration Engine
 *
 * Configuration-driven architecture for Lead Module V2.
 * All configuration entities are defined here and served via API.
 * Frontend executes config — NO hardcoded category branching in frontend.
 */

'use strict';

// ─── Entity Config ────────────────────────────────────────────────────────────

const EntityConfig = {
  Lead: {
    entityKey: 'Lead',
    displayName: 'Client',
    pluralName: 'Clients',
    idField: 'LeadID',
    statuses: ['New', 'Contacted', 'Follow-up', 'Qualified', 'Requirement Created', 'Site Visit', 'Negotiation', 'Won', 'Lost'],
    defaultStatus: 'New',
    lifecycles: ['Prospect', 'Client', 'Past Client', 'Inactive', 'Blacklisted'],
    defaultLifecycle: 'Prospect',
    immutableFields: ['LeadID', 'LegacyID', 'CreatedAt', 'CreatedBy']
  },
  Transaction: {
    entityKey: 'Transaction',
    displayName: 'Transaction',
    pluralName: 'Transactions',
    idField: 'TransactionID',
    types: ['Purchase', 'Sale', 'Rent', 'Rent Out', 'Lease', 'Lease Out'],
    statuses: ['Open', 'Active', 'Hold', 'Lost', 'Closed', 'Cancelled'],
    defaultStatus: 'Open',
    pipelineStages: ['New', 'Matching', 'Shortlisted', 'Site Visit', 'Negotiation', 'Token', 'Deal'],
    defaultStage: 'New',
    immutableFields: ['TransactionID', 'LeadID', 'LegacyID', 'CreatedAt', 'CreatedBy']
  },
  Requirement: {
    entityKey: 'Requirement',
    displayName: 'Requirement',
    pluralName: 'Requirements',
    idField: 'RequirementID',
    statuses: ['Draft', 'Active', 'Paused', 'Closed', 'Lost', 'Archived'],
    defaultStatus: 'Draft',
    pipelineStages: ['New', 'Matching', 'Shortlisted', 'Site Visit', 'Negotiation', 'Token', 'Deal'],
    defaultStage: 'New',
    immutableFields: ['RequirementID', 'LeadID', 'TransactionID', 'LegacyID', 'FormVersion', 'CreatedAt', 'CreatedBy']
  }
};

// ─── Tag System (PHASE 12) ────────────────────────────────────────────────────

const TagConfig = {
  availableTags: [
    { value: 'Investor',  label: 'Investor',  color: '#7c3aed' },
    { value: 'Buyer',     label: 'Buyer',     color: '#2563eb' },
    { value: 'Seller',    label: 'Seller',    color: '#16a34a' },
    { value: 'Tenant',    label: 'Tenant',    color: '#0891b2' },
    { value: 'Landlord',  label: 'Landlord',  color: '#b45309' },
    { value: 'Builder',   label: 'Builder',   color: '#dc2626' },
    { value: 'NRI',       label: 'NRI',       color: '#9333ea' },
    { value: 'Corporate', label: 'Corporate', color: '#0f766e' },
    { value: 'VIP',       label: 'VIP',       color: '#ca8a04' },
    { value: 'Hot',       label: 'Hot 🔥',   color: '#ef4444' },
    { value: 'Referral',  label: 'Referral',  color: '#6366f1' },
    { value: 'Duplicate Number', label: 'Duplicate Number', color: '#b45309' },
    { value: 'Invalid Number', label: 'Invalid Number', color: '#dc2626' }
  ]
};

// ─── Scoring Config (PHASE 11) ────────────────────────────────────────────────

const ScoringConfig = {
  client: {
    version: '1.0',
    maxScore: 100,
    rules: [
      { field: 'ClientStatus',    weight: 20, scoring: { New: 5, Verified: 10, Active: 20, Inactive: 5, Blacklisted: 0 } },
      { field: 'ClientLifecycle', weight: 20, scoring: { Prospect: 5, Client: 20, 'Past Client': 10, Inactive: 3, Blacklisted: 0 } },
      { field: 'hasPhone',        weight: 15, scoring: { true: 15, false: 0 } },
      { field: 'hasEmail',        weight: 10, scoring: { true: 10, false: 0 } },
      { field: 'hasTags',         weight: 10, scoring: { true: 10, false: 0 } },
      { field: 'transactionCount', weight: 15, scoring: 'linear', maxValue: 3, maxScore: 15 },
      { field: 'requirementCount', weight: 10, scoring: 'linear', maxValue: 3, maxScore: 10 }
    ]
  },
  requirement: {
    version: '1.0',
    maxScore: 100,
    rules: [
      { field: 'hasBudget',     weight: 20, scoring: { true: 20, false: 0 } },
      { field: 'hasLocation',   weight: 20, scoring: { true: 20, false: 0 } },
      { field: 'hasCategory',   weight: 15, scoring: { true: 15, false: 0 } },
      { field: 'urgency',       weight: 20, scoring: { High: 20, Medium: 10, Low: 5 } },
      { field: 'completeness',  weight: 25, scoring: 'percent', maxScore: 25 }
    ]
  }
};

// ─── Workflow Config (PHASE 11) ───────────────────────────────────────────────

const WorkflowConfig = {
  leadStatus: {
    transitions: {
      New: ['Contacted', 'Follow-up', 'Lost'],
      Contacted: ['Follow-up', 'Qualified', 'Requirement Created', 'Site Visit', 'Negotiation', 'Won', 'Lost'],
      'Follow-up': ['Qualified', 'Requirement Created', 'Site Visit', 'Negotiation', 'Won', 'Lost'],
      Qualified: ['Follow-up', 'Requirement Created', 'Site Visit', 'Negotiation', 'Won', 'Lost'],
      'Requirement Created': ['Follow-up', 'Site Visit', 'Negotiation', 'Won', 'Lost'],
      'Site Visit': ['Follow-up', 'Negotiation', 'Won', 'Lost'],
      Negotiation: ['Follow-up', 'Won', 'Lost'],
      Won: [],
      Lost: ['Contacted']
    }
  },
  clientLifecycle: {
    transitions: {
      Prospect:     ['Client', 'Inactive', 'Blacklisted'],
      Client:       ['Past Client', 'Inactive', 'Blacklisted'],
      'Past Client': ['Client', 'Inactive', 'Blacklisted'],
      Inactive:     ['Client', 'Blacklisted'],
      Blacklisted:  []
    }
  },
  requirementStatus: {
    transitions: {
      Draft:    ['Active', 'Archived'],
      Active:   ['Paused', 'Closed', 'Lost', 'Archived'],
      Paused:   ['Active', 'Closed', 'Lost', 'Archived'],
      Closed:   ['Archived'],
      Lost:     ['Active', 'Paused', 'Archived'],
      Archived: []
    }
  },
  transactionStatus: {
    transitions: {
      Open:      ['Active', 'Hold', 'Lost', 'Closed', 'Cancelled'],
      Active:    ['Hold', 'Lost', 'Closed', 'Cancelled'],
      Hold:      ['Open', 'Active', 'Lost', 'Closed', 'Cancelled'],
      Lost:      ['Open', 'Active', 'Closed', 'Cancelled'],
      Closed:    [],
      Cancelled: []
    }
  },
  pipelineStage: {
    ordered: ['New', 'Matching', 'Shortlisted', 'Site Visit', 'Negotiation', 'Token', 'Deal']
  }
};

// ─── Column Config (PHASE 15) ─────────────────────────────────────────────────

const ColumnConfig = {
  clientList: {
    version: '1.0',
    columns: [
      { key: 'ClientName',   label: 'Client Name',       sortable: true,  visible: true,  width: '200px' },
      { key: 'PrimaryMobile',label: 'Mobile',            sortable: false, visible: true,  width: '140px' },
      { key: 'ClientStatus', label: 'Status',            sortable: true,  visible: true,  width: '120px' },
      { key: 'ClientLifecycle', label: 'Lifecycle',      sortable: true,  visible: true,  width: '130px' },
      { key: 'Tags',         label: 'Tags',              sortable: false, visible: true,  width: '180px' },
      { key: 'requirementCount', label: 'Requirements',  sortable: true,  visible: true,  width: '110px' },
      { key: 'latestReqSummary', label: 'Latest Req',   sortable: false, visible: true,  width: '200px' },
      { key: 'budgetRange',  label: 'Budget',            sortable: false, visible: true,  width: '160px' },
      { key: 'location',     label: 'Location',          sortable: false, visible: true,  width: '140px' },
      { key: 'ClientScore',  label: 'Score',             sortable: true,  visible: true,  width: '80px' },
      { key: 'nextFollowUp', label: 'Follow-up',         sortable: true,  visible: true,  width: '130px' },
      { key: 'AssignedAgentID', label: 'Agent',          sortable: true,  visible: false, width: '120px' },
      { key: 'Source',       label: 'Source',            sortable: true,  visible: false, width: '120px' },
      { key: 'CreatedAt',    label: 'Created',           sortable: true,  visible: false, width: '120px' }
    ]
  },
  globalRequirements: {
    version: '1.0',
    columns: [
      { key: 'RequirementID',    label: 'Req ID',         sortable: true,  visible: true, width: '100px' },
      { key: 'clientName',       label: 'Client',         sortable: true,  visible: true, width: '180px' },
      { key: 'TransactionType',  label: 'Type',           sortable: true,  visible: true, width: '100px' },
      { key: 'Category',         label: 'Category',       sortable: true,  visible: true, width: '120px' },
      { key: 'SubCategory',      label: 'Sub Cat',        sortable: true,  visible: true, width: '120px' },
      { key: 'budgetRange',      label: 'Budget',         sortable: false, visible: true, width: '160px' },
      { key: 'Location1',        label: 'Location',       sortable: true,  visible: true, width: '140px' },
      { key: 'RequirementStatus',label: 'Status',         sortable: true,  visible: true, width: '110px' },
      { key: 'PipelineStage',    label: 'Stage',          sortable: true,  visible: true, width: '120px' },
      { key: 'Urgency',          label: 'Urgency',        sortable: true,  visible: true, width: '90px' },
      { key: 'RequirementScore', label: 'Score',          sortable: true,  visible: true, width: '80px' },
      { key: 'CreatedAt',        label: 'Created',        sortable: true,  visible: false, width: '120px' }
    ]
  }
};

// ─── V2 Form Registry (PHASE 9) ───────────────────────────────────────────────
// Registry key: TransactionType + Category + SubCategory
// Each entry is versioned and immutable once a Requirement is created.

const FORM_REGISTRY_VERSION = '2.1';

const V2FormRegistry = {
  // ── Residential ─────────────────────────────────────────────────────────────
  'Purchase|Residential|Flat': buildResidentialForm('Purchase', 'Residential', 'Flat', ['1BHK', '2BHK', '3BHK', '4BHK', '5BHK+']),
  'Purchase|Residential|Villa': buildResidentialForm('Purchase', 'Residential', 'Villa', ['3BHK', '4BHK', '5BHK+']),
  'Purchase|Residential|Row House': buildResidentialForm('Purchase', 'Residential', 'Row House', ['2BHK', '3BHK', '4BHK']),
  'Purchase|Residential|Bungalow': buildResidentialForm('Purchase', 'Residential', 'Bungalow', ['3BHK', '4BHK', '5BHK+']),
  'Purchase|Residential|Penthouse': buildResidentialForm('Purchase', 'Residential', 'Penthouse', ['3BHK', '4BHK', '5BHK+']),
  'Purchase|Residential|Studio': buildResidentialForm('Purchase', 'Residential', 'Studio', ['Studio']),

  'Rent|Residential|Flat': buildResidentialForm('Rent', 'Residential', 'Flat', ['1BHK', '2BHK', '3BHK', '4BHK']),
  'Rent|Residential|Villa': buildResidentialForm('Rent', 'Residential', 'Villa', ['3BHK', '4BHK', '5BHK+']),
  'Rent|Residential|Row House': buildResidentialForm('Rent', 'Residential', 'Row House', ['2BHK', '3BHK']),
  'Rent|Residential|Bungalow': buildResidentialForm('Rent', 'Residential', 'Bungalow', ['3BHK', '4BHK', '5BHK+']),

  'Rent Out|Residential|Flat': buildResidentialForm('Rent Out', 'Residential', 'Flat', ['1BHK', '2BHK', '3BHK', '4BHK']),
  'Rent Out|Residential|Villa': buildResidentialForm('Rent Out', 'Residential', 'Villa', ['3BHK', '4BHK', '5BHK+']),

  'Sale|Residential|Flat': buildResidentialForm('Sale', 'Residential', 'Flat', ['1BHK', '2BHK', '3BHK', '4BHK', '5BHK+']),
  'Sale|Residential|Villa': buildResidentialForm('Sale', 'Residential', 'Villa', ['3BHK', '4BHK', '5BHK+']),
  'Sale|Residential|Row House': buildResidentialForm('Sale', 'Residential', 'Row House', ['2BHK', '3BHK', '4BHK']),
  'Sale|Residential|Bungalow': buildResidentialForm('Sale', 'Residential', 'Bungalow', ['3BHK', '4BHK', '5BHK+']),

  'Lease|Residential|Flat': buildResidentialForm('Lease', 'Residential', 'Flat', ['2BHK', '3BHK', '4BHK']),
  'Lease Out|Residential|Flat': buildResidentialForm('Lease Out', 'Residential', 'Flat', ['2BHK', '3BHK', '4BHK']),

  // ── Commercial ──────────────────────────────────────────────────────────────
  'Purchase|Commercial|Office': buildCommercialForm('Purchase', 'Commercial', 'Office'),
  'Purchase|Commercial|Shop': buildCommercialForm('Purchase', 'Commercial', 'Shop'),
  'Purchase|Commercial|Showroom': buildCommercialForm('Purchase', 'Commercial', 'Showroom'),
  'Purchase|Commercial|Warehouse': buildCommercialForm('Purchase', 'Commercial', 'Warehouse'),

  'Rent|Commercial|Office': buildCommercialForm('Rent', 'Commercial', 'Office'),
  'Rent|Commercial|Shop': buildCommercialForm('Rent', 'Commercial', 'Shop'),
  'Rent|Commercial|Showroom': buildCommercialForm('Rent', 'Commercial', 'Showroom'),
  'Rent|Commercial|Warehouse': buildCommercialForm('Rent', 'Commercial', 'Warehouse'),

  'Rent Out|Commercial|Office': buildCommercialForm('Rent Out', 'Commercial', 'Office'),
  'Rent Out|Commercial|Shop': buildCommercialForm('Rent Out', 'Commercial', 'Shop'),
  'Sale|Commercial|Office': buildCommercialForm('Sale', 'Commercial', 'Office'),
  'Sale|Commercial|Shop': buildCommercialForm('Sale', 'Commercial', 'Shop'),
  'Sale|Commercial|Showroom': buildCommercialForm('Sale', 'Commercial', 'Showroom'),
  'Sale|Commercial|Warehouse': buildCommercialForm('Sale', 'Commercial', 'Warehouse'),
  'Lease|Commercial|Office': buildCommercialForm('Lease', 'Commercial', 'Office'),
  'Lease|Commercial|Shop': buildCommercialForm('Lease', 'Commercial', 'Shop'),
  'Lease|Commercial|Showroom': buildCommercialForm('Lease', 'Commercial', 'Showroom'),
  'Lease|Commercial|Warehouse': buildCommercialForm('Lease', 'Commercial', 'Warehouse'),
  'Lease Out|Commercial|Office': buildCommercialForm('Lease Out', 'Commercial', 'Office'),
  'Lease Out|Commercial|Shop': buildCommercialForm('Lease Out', 'Commercial', 'Shop'),
  'Lease Out|Commercial|Showroom': buildCommercialForm('Lease Out', 'Commercial', 'Showroom'),
  'Lease Out|Commercial|Warehouse': buildCommercialForm('Lease Out', 'Commercial', 'Warehouse'),

  // ── Land ────────────────────────────────────────────────────────────────────
  'Purchase|Land|Residential Plot': buildLandForm('Purchase', 'Land', 'Residential Plot'),
  'Purchase|Land|Commercial Plot': buildLandForm('Purchase', 'Land', 'Commercial Plot'),
  'Purchase|Land|Agricultural Land': buildLandForm('Purchase', 'Land', 'Agricultural Land'),
  'Sale|Land|Residential Plot': buildLandForm('Sale', 'Land', 'Residential Plot'),
  'Sale|Land|Commercial Plot': buildLandForm('Sale', 'Land', 'Commercial Plot'),
  'Sale|Land|Agricultural Land': buildLandForm('Sale', 'Land', 'Agricultural Land'),
  'Lease|Land|Residential Plot': buildLandForm('Lease', 'Land', 'Residential Plot'),
  'Lease|Land|Commercial Plot': buildLandForm('Lease', 'Land', 'Commercial Plot'),
  'Lease|Land|Agricultural Land': buildLandForm('Lease', 'Land', 'Agricultural Land'),

  // ── Industrial ──────────────────────────────────────────────────────────────
  'Purchase|Industrial|Factory': buildIndustrialForm('Purchase', 'Industrial', 'Factory'),
  'Purchase|Industrial|Warehouse': buildIndustrialForm('Purchase', 'Industrial', 'Warehouse'),
  'Rent|Industrial|Factory': buildIndustrialForm('Rent', 'Industrial', 'Factory'),
  'Rent|Industrial|Warehouse': buildIndustrialForm('Rent', 'Industrial', 'Warehouse'),
  'Lease|Industrial|Factory': buildIndustrialForm('Lease', 'Industrial', 'Factory'),
  'Lease|Industrial|Warehouse': buildIndustrialForm('Lease', 'Industrial', 'Warehouse'),
  'Lease Out|Industrial|Factory': buildIndustrialForm('Lease Out', 'Industrial', 'Factory'),
  'Lease Out|Industrial|Warehouse': buildIndustrialForm('Lease Out', 'Industrial', 'Warehouse'),

  // ── Agriculture ─────────────────────────────────────────────────────────────
  'Purchase|Agriculture|Agricultural Land': buildAgricultureForm('Purchase', 'Agriculture', 'Agricultural Land'),
  'Purchase|Agriculture|Farm House':        buildAgricultureForm('Purchase', 'Agriculture', 'Farm House'),
  'Purchase|Agriculture|Orchard':           buildAgricultureForm('Purchase', 'Agriculture', 'Orchard'),
  'Sale|Agriculture|Agricultural Land':     buildAgricultureForm('Sale',     'Agriculture', 'Agricultural Land'),
  'Sale|Agriculture|Farm House':            buildAgricultureForm('Sale',     'Agriculture', 'Farm House'),
  'Lease|Agriculture|Agricultural Land':    buildAgricultureForm('Lease',    'Agriculture', 'Agricultural Land'),
  'Lease Out|Agriculture|Agricultural Land':buildAgricultureForm('Lease Out','Agriculture', 'Agricultural Land'),

  // Fallback generic
  'generic': buildGenericForm()
};

// Complete the registry for every supported deal direction. This keeps the
// category and subtype selectors usable regardless of who is asking (buyer,
// seller, tenant, landlord, lessee, or lessor).
const CATEGORY_SUBTYPES = {
  Residential: ['Flat', 'Terrace Flat', 'Villa', 'Row House', 'Bungalow', 'Penthouse', 'Studio', 'Duplex', 'Builder Floor', 'Independent House', 'Residential Plot'],
  Commercial: ['Office', 'Shop', 'Showroom', 'Warehouse', 'Co-working Space', 'Restaurant', 'Clinic', 'Commercial Plot'],
  Industrial: ['Factory', 'Warehouse', 'Industrial Shed', 'Industrial Plot', 'Cold Storage', 'Logistics Facility'],
  Land: ['Residential Plot', 'Commercial Plot', 'Industrial Plot', 'Agricultural Land'],
  Agriculture: ['Agricultural Land', 'Farm House', 'Orchard', 'Plantation']
};
const TRANSACTION_TYPES = ['Purchase', 'Sale', 'Rent', 'Rent Out', 'Lease', 'Lease Out'];

for (const transactionType of TRANSACTION_TYPES) {
  for (const [category, subCategories] of Object.entries(CATEGORY_SUBTYPES)) {
    for (const subCategory of subCategories) {
      const key = `${transactionType}|${category}|${subCategory}`;
      if (V2FormRegistry[key]) continue;
      let form;
      if (subCategory.endsWith('Plot')) {
        form = buildLandForm(transactionType, category, subCategory);
      } else if (category === 'Residential') {
        form = buildResidentialForm(transactionType, category, subCategory,
          subCategory === 'Studio' ? ['Studio'] : ['1BHK', '2BHK', '3BHK', '4BHK', '5BHK+']);
      } else if (category === 'Commercial') {
        form = buildCommercialForm(transactionType, category, subCategory);
      } else if (category === 'Industrial') {
        form = buildIndustrialForm(transactionType, category, subCategory);
      } else if (category === 'Land') {
        form = buildLandForm(transactionType, category, subCategory);
      } else {
        form = buildAgricultureForm(transactionType, category, subCategory);
      }
      form.formKey = key;
      form.formName = `${transactionType} — ${category} — ${subCategory}`;
      V2FormRegistry[key] = form;
    }
  }
}

// ─── Form Builders ────────────────────────────────────────────────────────────

function buildCommonFields(txnType) {
  const isMonthlyRent = txnType === 'Rent' || txnType === 'Rent Out';
  const isLease = txnType === 'Lease' || txnType === 'Lease Out';
  const budgetMinLabel = isMonthlyRent ? 'Monthly Rent Min (₹)' : isLease ? 'Lease Budget Min (₹)' : 'Budget Min (₹)';
  const budgetMaxLabel = isMonthlyRent ? 'Monthly Rent Max (₹)' : isLease ? 'Lease Budget Max (₹)' : 'Budget Max (₹)';
  return {
    budgetMin: field('budgetMin', budgetMinLabel, 'Number', false, 1, { validation: 'positive-number', budgetRole: 'min' }),
    budgetMax: field('budgetMax', budgetMaxLabel, 'Number', false, 2, { validation: 'positive-number', budgetRole: 'max' }),
    budgetType: field('budgetType', 'Budget Type', 'Select', false, 3, { options: ['All Inclusive', 'Base Price', 'Negotiable'] }),
    budgetFlexibility: field('budgetFlexibility', 'Budget Flexibility', 'Select', false, 4, { options: ['Strict', 'Slightly Flexible', 'Very Flexible'] }),
    location1: field('Location1', 'Primary Location', 'Text', true, 5),
    location2: field('Location2', 'Secondary Location', 'Text', false, 6),
    location3: field('Location3', 'Tertiary Location', 'Text', false, 7),
    avoidLocations: field('AvoidLocations', 'Avoid Locations', 'Text', false, 8),
    possession: field('Possession', 'Possession', 'Select', false, 9, { options: ['Ready', 'Ready to Move', '0-6 Months', '6-12 Months', '1-2 Years', '2-3 Years', '3+ Years'] }),
    urgency: field('Urgency', 'Urgency', 'Select', true, 10, { options: ['Immediate', 'High', 'Medium', 'Low'] }),
    moveInDate: field('MoveInDate', 'Move-in Date', 'Date', false, 11),
    preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
  };
}

// Rental and lease fields are shared by tenant-side and owner-side transactions.
function isRentalTransaction(txnType) {
  return ['Rent', 'Rent Out', 'Lease', 'Lease Out'].includes(txnType);
}

function buildRentSpecificFields(txnType) {
  const isOwnerSide = txnType === 'Rent Out' || txnType === 'Lease Out';
  const fields = {
    tenantType:         field('TenantType', isOwnerSide ? 'Preferred Tenant' : 'Tenant Type', 'Select', false, 30, { options: ['Family', 'Bachelor', 'Company', 'Any'] }),
    deposit:            field('Deposit', 'Security Deposit (months)', 'Number', false, 31, { validation: 'positive-number' }),
    maintenanceCharges: field('MaintenanceCharges', 'Maintenance Charges (₹/month)', 'Number', false, 32),
    petAllowed:         field('PetAllowed', 'Pets Allowed', 'Boolean', false, 33)
  };
  if (txnType === 'Lease' || txnType === 'Lease Out') {
    fields.leaseTerm = field('LeaseTerm', 'Preferred Lease Term', 'Select', false, 34, { options: ['11 Months', '1 Year', '3 Years', '5 Years', 'Flexible'] });
  }
  return fields;
}

function buildPropertySourceFields(txnType) {
  return txnType === 'Purchase'
    ? { propertySource: field('PropertySource', 'Project / Resale Preference', 'Select', false, 12, { options: ['Resale', 'New Project', 'Both'] }) }
    : {};
}

function buildResidentialForm(txnType, category, subCategory, bhkOptions) {
  const isApartment = ['Flat', 'Terrace Flat', 'Penthouse', 'Studio', 'Duplex', 'Builder Floor'].includes(subCategory);
  const isIndependentHome = ['Villa', 'Row House', 'Bungalow', 'Independent House'].includes(subCategory);
  const hasTerrace = ['Terrace Flat', 'Penthouse'].includes(subCategory);
  const fields = {
    ...buildCommonFields(txnType),
    ...(isRentalTransaction(txnType) ? buildRentSpecificFields(txnType) : {}),
    ...buildPropertySourceFields(txnType),
    bhkMin: field('BHKMin', 'BHK Min', 'Select', false, 20, { options: bhkOptions }),
    bhkMax: field('BHKMax', 'BHK Max', 'Select', false, 21, { options: bhkOptions }),
    areaMin: field('AreaMin', 'Area Min', 'Number', false, 22, { validation: 'positive-number' }),
    areaMax: field('AreaMax', 'Area Max', 'Number', false, 23, { validation: 'positive-number' }),
    areaType: field('AreaType', 'Area Type', 'Select', false, 23.5, { options: ['Carpet Area', 'Built-up Area', 'Super Built-up Area'] }),
    furnishing: field('Furnishing', 'Furnishing', 'Select', false, 24, { options: ['Unfurnished', 'Semi-Furnished', 'Fully Furnished', 'Any'] }),
    completionStatus: field('CompletionStatus', 'Property Condition / Construction Status', 'Select', false, 24.5, { options: ['Ready to Move', 'Under Construction', 'New Launch', 'Resale - Occupied', 'Unfinished / Incomplete', 'Renovation Required', 'Any'] }),
    propertyAge: field('PropertyAge', 'Property Age (years)', 'Number', false, 24.7, { validation: 'positive-number' }),
    bathroomsMin: field('BathroomsMin', 'Bathrooms Min', 'Number', false, 24.8, { validation: 'positive-number' }),
    bathroomsMax: field('BathroomsMax', 'Bathrooms Max', 'Number', false, 24.9, { validation: 'positive-number' }),
    balconiesMin: field('BalconiesMin', 'Balconies Min', 'Number', false, 24.95, { validation: 'positive-number' }),
    facing: field('Facing', 'Facing', 'Select', false, 25, { options: ['East', 'West', 'North', 'South', 'North-East', 'North-West', 'South-East', 'South-West', 'Any'] }),
    floor: field('Floor', 'Floor Preference', 'Select', false, 26, { options: ['Ground', 'Low (1-5)', 'Mid (6-15)', 'High (16+)', 'Top Floor', 'Any'] }),
    parking: field('Parking', 'Parking', 'MultiSelect', false, 27, { options: ['2 Wheeler', 'Car', 'Covered', 'Open', 'No Preference'] }),
    vastu: field('Vastu', 'Vastu Compliant', 'Boolean', false, 28),
    gatedCommunity: field('GatedCommunity', 'Gated Community', 'Boolean', false, 29),
    amenities: field('ResidentialAmenities', 'Amenities', 'MultiSelect', false, 30, { options: ['Lift', 'Power Backup', 'Security', 'Gym', 'Swimming Pool', 'Clubhouse', 'Garden', 'Children Play Area', 'Intercom', 'Visitor Parking'] }),
    ...hasTerrace ? {
      terraceRequired: field('TerraceRequired', 'Private Terrace Required', 'Boolean', false, 31),
      terraceArea: field('TerraceArea', 'Preferred Terrace Area (sq.ft)', 'Number', false, 32, { validation: 'positive-number' })
    } : {},
    ...isIndependentHome ? {
      plotAreaMin: field('PlotAreaMin', 'Plot Area Min (sq.yd)', 'Number', false, 33, { validation: 'positive-number' }),
      plotAreaMax: field('PlotAreaMax', 'Plot Area Max (sq.yd)', 'Number', false, 34, { validation: 'positive-number' }),
      floorsCount: field('FloorsCount', 'Floors in House', 'Number', false, 35, { validation: 'positive-number' }),
      privateGarden: field('PrivateGarden', 'Private Garden', 'Boolean', false, 36),
      servantRoom: field('ServantRoom', 'Servant Room', 'Boolean', false, 37)
    } : {},
    ...(isApartment ? {
      societyPreference: field('SocietyPreference', 'Society / Project Preference', 'Text', false, 38)
    } : {}),
    preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
  };
  return {
    formKey: `${txnType}|${category}|${subCategory}`,
    formVersion: FORM_REGISTRY_VERSION,
    formName: `${txnType} — ${category} — ${subCategory}`,
    transactionType: txnType,
    category,
    subCategory,
    isActive: true,
    fields,
    dependencies: [
      { field: 'BHKMax', dependsOn: 'BHKMin', rule: 'gte', errorMessage: 'BHK Max must be ≥ BHK Min' },
      { field: 'AreaMax', dependsOn: 'AreaMin', rule: 'gte', errorMessage: 'Area Max must be ≥ Area Min' },
      { field: 'BathroomsMax', dependsOn: 'BathroomsMin', rule: 'gte', errorMessage: 'Bathrooms Max must be ≥ Bathrooms Min' },
      { field: 'PlotAreaMax', dependsOn: 'PlotAreaMin', rule: 'gte', errorMessage: 'Plot Area Max must be ≥ Plot Area Min' },
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function buildCommercialForm(txnType, category, subCategory) {
  const isOffice = subCategory === 'Office' || subCategory === 'Co-working Space';
  const isShopfront = ['Shop', 'Showroom'].includes(subCategory);
  const isStorage = ['Warehouse'].includes(subCategory);
  const isHospitality = ['Restaurant'].includes(subCategory);
  const isClinic = ['Clinic'].includes(subCategory);
  const officeFields = isOffice ? {
    furnishing: field('Furnishing', 'Furnishing', 'Select', false, 23, { Section: 'Office Details', options: ['Fully Furnished', 'Part Furnished', 'Unfurnished', 'Bare Shell', 'Managed / Co-working'] }),
    officeSeatsMin: field('OfficeSeatsMin', 'Seats Min', 'Number', false, 24, { Section: 'Office Details', validation: 'positive-number' }),
    officeSeatsMax: field('OfficeSeatsMax', 'Seats Max', 'Number', false, 25, { Section: 'Office Details', validation: 'positive-number' }),
    workstationsMin: field('WorkstationsMin', 'Workstations Min', 'Number', false, 26, { Section: 'Office Layout', validation: 'positive-number' }),
    workstationsMax: field('WorkstationsMax', 'Workstations Max', 'Number', false, 27, { Section: 'Office Layout', validation: 'positive-number' }),
    cabins: field('Cabins', 'Private Cabins', 'Number', false, 28, { Section: 'Office Layout', validation: 'positive-number' }),
    meetingRooms: field('MeetingRooms', 'Meeting / Conference Rooms', 'Number', false, 29, { Section: 'Office Layout', validation: 'positive-number' }),
    floorPreference: field('FloorPreference', 'Floor Preference', 'Select', false, 30, { Section: 'Office Details', options: ['Ground', 'Low (1-5)', 'Mid (6-15)', 'High (16+)', 'Any'] }),
    buildingGrade: field('BuildingGrade', 'Building / Park Type', 'Select', false, 31, { Section: 'Office Details', options: ['Grade A', 'Grade B', 'Grade C', 'IT Park', 'Business Park', 'Any'] }),
    airConditioning: field('AirConditioning', 'Air Conditioning', 'Select', false, 32, { Section: 'Facilities', options: ['Central AC', 'Split AC', 'VRV / VRF', 'Not Required', 'Any'] }),
    powerBackup: field('PowerBackup', 'Power Backup', 'Select', false, 33, { Section: 'Facilities', options: ['Full Backup', 'Common Areas Only', 'Not Required', 'Any'] }),
    officeAmenities: field('OfficeAmenities', 'Office Facilities', 'MultiSelect', false, 34, { Section: 'Facilities', options: ['Reception', 'Pantry', 'Private Washroom', 'Internet / Fiber', 'Server Room', 'Visitor Parking', 'Security / Access Control'] })
  } : {};
  const shopFields = isShopfront ? {
    frontageWidth: field('FrontageWidth', 'Frontage Width (ft)', 'Number', false, 37, { validation: 'positive-number' }),
    frontageDirection: field('FrontageDirection', 'Frontage / Facing', 'Select', false, 37.1, { options: ['Main Road', 'Corner', 'Mall / High Street', 'Internal Road', 'Any'] }),
    displayWindow: field('DisplayWindow', 'Display Window Required', 'Boolean', false, 37.2),
    footfall: field('Footfall', 'Preferred Footfall', 'Select', false, 37.3, { options: ['High', 'Medium', 'Low', 'Any'] }),
    shopFloor: field('ShopFloor', 'Preferred Floor', 'Select', false, 37.4, { options: ['Ground', 'First', 'Upper Floor', 'Mall Floor', 'Any'] })
  } : {};
  const storageFields = isStorage ? {
    clearHeight: field('ClearHeight', 'Clear Height (ft)', 'Number', false, 40, { validation: 'positive-number' }),
    loadingBays: field('LoadingBays', 'Loading Bays', 'Number', false, 41, { validation: 'positive-number' }),
    dockAccess: field('DockAccess', 'Dock / Truck Access', 'Boolean', false, 42),
    floorLoad: field('FloorLoad', 'Floor Load Capacity', 'Text', false, 43),
    coldStorage: field('ColdStorage', 'Cold Storage Required', 'Boolean', false, 44)
  } : {};
  const hospitalityFields = isHospitality ? {
    seatingCapacity: field('SeatingCapacity', 'Seating Capacity', 'Number', false, 45, { validation: 'positive-number' }),
    kitchenExhaust: field('KitchenExhaust', 'Kitchen Exhaust / Chimney', 'Boolean', false, 46),
    gasConnection: field('GasConnection', 'Commercial Gas Connection', 'Boolean', false, 47),
    outdoorSeating: field('OutdoorSeating', 'Outdoor Seating', 'Boolean', false, 48)
  } : {};
  const clinicFields = isClinic ? {
    consultationRooms: field('ConsultationRooms', 'Consultation Rooms', 'Number', false, 45, { validation: 'positive-number' }),
    medicalUse: field('MedicalUse', 'Clinic / Diagnostic Use', 'Select', false, 46, { options: ['Clinic', 'Dental', 'Diagnostic', 'Day Care', 'Any'] }),
    liftAccess: field('LiftAccess', 'Patient Lift Access', 'Boolean', false, 47)
  } : {};
  return {
    formKey: `${txnType}|${category}|${subCategory}`,
    formVersion: FORM_REGISTRY_VERSION,
    formName: `${txnType} — ${category} — ${subCategory}`,
    transactionType: txnType,
    category,
    subCategory,
    isActive: true,
    fields: {
      ...buildCommonFields(txnType),
      ...buildPropertySourceFields(txnType),
      ...(isRentalTransaction(txnType) ? buildRentSpecificFields(txnType) : {}),
      areaMin: field('AreaMin', 'Area Min (sq.ft)', 'Number', false, 20, { validation: 'positive-number' }),
      areaMax: field('AreaMax', 'Area Max (sq.ft)', 'Number', false, 21, { validation: 'positive-number' }),
      areaType: field('AreaType', 'Area Type', 'Select', false, 21.5, { options: ['Carpet Area', 'Built-up Area', 'Super Built-up Area'] }),
      businessType: field('BusinessType', isOffice ? 'Office Use' : 'Business Type', 'Select', false, 22, { options: isOffice ? ['Corporate Office', 'IT / ITES', 'Consulting / Professional Services', 'Finance', 'Back Office', 'Branch Office', 'Other'] : ['Retail', 'Office', 'Hospitality', 'Healthcare', 'Education', 'IT/ITES', 'Other'] }),
      ...officeFields,
      ...shopFields,
      ...storageFields,
      ...hospitalityFields,
      ...clinicFields,
      powerLoad: field('PowerLoad', 'Power Load (KW)', 'Number', false, 49),
      fireNoc: field('FireNOC', 'Fire NOC Required', 'Boolean', false, 49.1),
      parkingSlots: field('ParkingSlots', 'Parking Slots', 'Number', false, 49.2, { validation: 'positive-number' }),
      liftRequired: field('LiftRequired', 'Lift Required', 'Boolean', false, 49.3),
      washrooms: field('Washrooms', 'Washrooms', 'Number', false, 49.4, { validation: 'positive-number' }),
      preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
    },
    dependencies: [
      { field: 'AreaMax', dependsOn: 'AreaMin', rule: 'gte', errorMessage: 'Area Max must be ≥ Area Min' },
      { field: 'OfficeSeatsMax', dependsOn: 'OfficeSeatsMin', rule: 'gte', errorMessage: 'Seats Max must be ≥ Seats Min' },
      { field: 'WorkstationsMax', dependsOn: 'WorkstationsMin', rule: 'gte', errorMessage: 'Workstations Max must be ≥ Workstations Min' },
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function buildAgricultureForm(txnType, category, subCategory) {
  const isFarmHouse = subCategory === 'Farm House';
  const isOrchard = ['Orchard', 'Plantation'].includes(subCategory);
  return {
    formKey: `${txnType}|${category}|${subCategory}`,
    formVersion: FORM_REGISTRY_VERSION,
    formName: `${txnType} — ${category} — ${subCategory}`,
    transactionType: txnType,
    category,
    subCategory,
    isActive: true,
    fields: {
      ...buildCommonFields(txnType),
      ...buildPropertySourceFields(txnType),
      ...(isRentalTransaction(txnType) ? buildRentSpecificFields(txnType) : {}),
      totalArea: field('TotalArea', 'Total Area', 'Number', false, 20, { validation: 'positive-number' }),
      areaUnit: field('AreaUnit', 'Area Unit', 'Select', false, 20.1, { options: ['Acre', 'Hectare', 'Bigha', 'Sq. yard', 'Sq. ft'] }),
      agriculturalUse: field('AgriculturalUse', 'Land Use', 'Select', false, 20.2, { options: ['Crop Farming', 'Orchard', 'Plantation', 'Dairy / Livestock', 'Farm House', 'Other'] }),
      waterSource: field('WaterSource', 'Water Source', 'MultiSelect', false, 21, { options: ['Well', 'Borewell', 'Canal', 'River', 'Rainwater', 'None'] }),
      soilType: field('SoilType', 'Soil Type', 'Select', false, 22, { options: ['Black', 'Red', 'Alluvial', 'Sandy', 'Loamy', 'Mixed', 'Unknown'] }),
      electricityAvailable: field('ElectricityAvailable', 'Electricity Available', 'Boolean', false, 23),
      roadAccess: field('RoadAccess', 'Road Access', 'Select', false, 24, { options: ['Public Road', 'Private Road', 'Tractor Access', 'No Direct Access'] }),
      irrigationAvailable: field('IrrigationAvailable', 'Irrigation Available', 'Boolean', false, 25),
      fencing: field('Fencing', 'Fencing Available', 'Boolean', false, 26),
      cropType: field('CropType', isOrchard ? 'Crop / Tree Type' : 'Preferred Crop', 'Text', false, 27),
      landLevel: field('LandLevel', 'Land Level / Slope', 'Select', false, 28, { options: ['Level', 'Gentle Slope', 'Uneven', 'Any'] }),
      ...isFarmHouse ? {
        bedrooms: field('FarmHouseBedrooms', 'Bedrooms', 'Number', false, 29, { validation: 'positive-number' }),
        houseCondition: field('FarmHouseCondition', 'Farm House Condition', 'Select', false, 30, { options: ['Ready', 'Needs Repair', 'Under Construction', 'Any'] }),
        poolRequired: field('FarmHousePool', 'Swimming Pool', 'Boolean', false, 31)
      } : {},
      preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
    },
    dependencies: [
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function buildLandForm(txnType, category, subCategory) {
  const isAgriculturalLand = subCategory === 'Agricultural Land';
  const zoningOptions = isAgriculturalLand
    ? ['Agricultural', 'Orchard / Plantation', 'Farm House', 'Any']
    : subCategory === 'Residential Plot'
      ? ['Residential', 'Mixed Use', 'Any']
      : subCategory === 'Commercial Plot'
        ? ['Commercial', 'Mixed Use', 'Any']
        : subCategory === 'Industrial Plot'
          ? ['Industrial', 'Commercial', 'Any']
          : ['Agricultural', 'Residential', 'Any'];
  return {
    formKey: `${txnType}|${category}|${subCategory}`,
    formVersion: FORM_REGISTRY_VERSION,
    formName: `${txnType} — ${category} — ${subCategory}`,
    transactionType: txnType,
    category,
    subCategory,
    isActive: true,
    fields: {
      ...buildCommonFields(txnType),
      ...buildPropertySourceFields(txnType),
      ...(isRentalTransaction(txnType) ? buildRentSpecificFields(txnType) : {}),
      ...(isAgriculturalLand ? {
        totalArea: field('TotalArea', 'Total Agricultural Area', 'Number', false, 20, { validation: 'positive-number' }),
        areaUnit: field('AreaUnit', 'Area Unit', 'Select', false, 20.1, { options: ['Acre', 'Hectare', 'Bigha', 'Sq. yard', 'Sq. ft'] }),
        soilType: field('SoilType', 'Soil Type', 'Select', false, 21, { options: ['Black', 'Red', 'Alluvial', 'Sandy', 'Loamy', 'Mixed', 'Unknown'] }),
        waterSource: field('WaterSource', 'Water Source', 'MultiSelect', false, 21.1, { options: ['Well', 'Borewell', 'Canal', 'River', 'Rainwater', 'None'] }),
        irrigationAvailable: field('IrrigationAvailable', 'Irrigation Available', 'Boolean', false, 21.2),
        cropType: field('CropType', 'Current / Preferred Crop', 'Text', false, 21.3),
        plotAreaMin: field('PlotAreaMin', 'Plot Area Min (sq.yd)', 'Number', false, 21.4, { validation: 'positive-number' }),
        plotAreaMax: field('PlotAreaMax', 'Plot Area Max (sq.yd)', 'Number', false, 21.5, { validation: 'positive-number' })
      } : {
        plotMin: field('PlotAreaMin', 'Plot Area Min', 'Number', false, 20, { validation: 'positive-number' }),
        plotMax: field('PlotAreaMax', 'Plot Area Max', 'Number', false, 21, { validation: 'positive-number' }),
        plotAreaUnit: field('PlotAreaUnit', 'Plot Area Unit', 'Select', false, 21.1, { options: ['Sq. yard', 'Sq. ft', 'Sq. metre', 'Acre', 'Hectare', 'Bigha'] })
      }),
      zoning: field('Zoning', isAgriculturalLand ? 'Land Use / Permitted Use' : 'Zoning / Permitted Use', 'Select', false, 22, { options: zoningOptions }),
      frontage: field('PlotFrontage', 'Frontage (ft)', 'Number', false, 23, { validation: 'positive-number' }),
      depth: field('PlotDepth', 'Depth (ft)', 'Number', false, 24, { validation: 'positive-number' }),
      approachRoad: field('ApproachRoad', 'Approach Road Width (ft)', 'Number', false, 25, { validation: 'positive-number' }),
      facing: field('PlotFacing', 'Plot Facing', 'Select', false, 26, { options: ['East', 'West', 'North', 'South', 'North-East', 'North-West', 'South-East', 'South-West', 'Any'] }),
      cornerPlot: field('CornerPlot', 'Corner Plot Preferred', 'Boolean', false, 27),
      landConversion: field('LandConversion', 'Land Conversion / NA Status', 'Select', false, 28, { options: ['NA / Converted', 'Non-NA', 'Conversion Required', 'Not Applicable', 'Unknown'] }),
      titleStatus: field('TitleStatus', 'Title / Ownership Status', 'Select', false, 29, { options: ['Clear Title', 'Leasehold', 'Freehold', 'Under Verification', 'Unknown'] }),
      fsiPreference: field('FSIPreference', 'FSI / FAR Requirement', 'Text', false, 30),
      utilities: field('PlotUtilities', 'Utilities', 'MultiSelect', false, 31, { options: ['Water Line', 'Electricity', 'Gas Pipeline', 'Drainage', 'Street Lighting'] }),
      preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
    },
    dependencies: [
      { field: 'PlotAreaMax', dependsOn: 'PlotAreaMin', rule: 'gte', errorMessage: 'Plot Max must be ≥ Plot Min' },
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function buildIndustrialForm(txnType, category, subCategory) {
  const isFactory = subCategory === 'Factory';
  const isWarehouse = ['Warehouse', 'Industrial Shed', 'Cold Storage', 'Logistics Facility'].includes(subCategory);
  return {
    formKey: `${txnType}|${category}|${subCategory}`,
    formVersion: FORM_REGISTRY_VERSION,
    formName: `${txnType} — ${category} — ${subCategory}`,
    transactionType: txnType,
    category,
    subCategory,
    isActive: true,
    fields: {
      ...buildCommonFields(txnType),
      ...buildPropertySourceFields(txnType),
      ...(isRentalTransaction(txnType) ? buildRentSpecificFields(txnType) : {}),
      areaMin: field('AreaMin', 'Area Min (sq.ft)', 'Number', false, 20, { validation: 'positive-number' }),
      areaMax: field('AreaMax', 'Area Max (sq.ft)', 'Number', false, 21, { validation: 'positive-number' }),
      areaType: field('AreaType', 'Area Type', 'Select', false, 21.5, { options: ['Carpet Area', 'Built-up Area', 'Plot Area'] }),
      zoneType: field('ZoneType', 'Industrial Use / Zone', 'Select', false, 22, { options: ['Manufacturing', 'Warehouse', 'Logistics', 'Cold Storage', 'Data Center', 'Industrial Estate', 'Any'] }),
      powerLoad: field('PowerLoad', 'Power Load (KW)', 'Number', false, 23, { validation: 'positive-number' }),
      powerSupply: field('PowerSupply', 'Power Supply', 'Select', false, 23.1, { options: ['Single Phase', '3 Phase', 'HT', 'Any'] }),
      loadingBay: field('LoadingBay', 'Loading Bay Required', 'Boolean', false, 24),
      ceilingHeight: field('CeilingHeight', 'Clear Ceiling Height (ft)', 'Number', false, 25, { validation: 'positive-number' }),
      flooringType: field('FlooringType', 'Flooring Type', 'Select', false, 26, { options: ['VDF', 'Epoxy', 'Tiles', 'Plain Cement', 'Heavy Duty', 'Any'] }),
      truckAccess: field('TruckAccess', 'Truck / Container Access', 'Select', false, 27, { options: ['Small Truck', 'Heavy Truck', 'Container', 'Any'] }),
      dockLevel: field('DockLevel', 'Dock Level / Loading Dock', 'Boolean', false, 28),
      fireNoc: field('FireNOC', 'Fire NOC / Safety Compliance', 'Boolean', false, 29),
      waterSupply: field('IndustrialWaterSupply', 'Water Supply', 'Select', false, 30, { options: ['Municipal', 'Borewell', 'Process Water', 'Any'] }),
      effluentTreatment: field('EffluentTreatment', 'Effluent Treatment Required', 'Boolean', false, 31),
      ...isFactory ? {
        craneCapacity: field('CraneCapacity', 'Crane Capacity', 'Text', false, 32),
        ventilation: field('FactoryVentilation', 'Industrial Ventilation', 'Boolean', false, 33),
        officeArea: field('FactoryOfficeArea', 'Office Area (sq.ft)', 'Number', false, 34, { validation: 'positive-number' })
      } : {},
      ...isWarehouse ? {
        loadingBaysCount: field('LoadingBaysCount', 'Loading Bays', 'Number', false, 35, { validation: 'positive-number' }),
        coldChain: field('ColdChain', 'Cold Chain / Temperature Control', 'Boolean', false, 36)
      } : {},
      preferences: field('Preferences', 'Additional Preferences', 'Textarea', false, 50)
    },
    dependencies: [
      { field: 'AreaMax', dependsOn: 'AreaMin', rule: 'gte', errorMessage: 'Area Max must be ≥ Area Min' },
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function buildGenericForm() {
  return {
    formKey: 'generic',
    formVersion: FORM_REGISTRY_VERSION,
    formName: 'Generic Requirement Form',
    transactionType: null,
    category: null,
    subCategory: null,
    isActive: true,
    fields: buildCommonFields(),
    dependencies: [
      { field: 'budgetMax', dependsOn: 'budgetMin', rule: 'gte', errorMessage: 'Budget Max must be ≥ Budget Min' }
    ]
  };
}

function field(id, label, type, required, order, extra = {}) {
  return {
    fieldId: id,
    fieldLabel: label,
    fieldType: type,
    required: !!required,
    displayOrder: order,
    visible: true,
    active: true,
    ...extra
  };
}

// ─── Validation Config (PHASE 10) ─────────────────────────────────────────────

const ValidationConfig = {
  rules: {
    'positive-number': { type: 'number', min: 0, errorMessage: 'Must be a positive number' },
    'required-text':   { type: 'text', minLength: 1, errorMessage: 'This field is required' },
    'mobile':          { type: 'regex', pattern: '^[+]?[0-9]{10,15}$', errorMessage: 'Invalid mobile number' },
    'email':           { type: 'regex', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', errorMessage: 'Invalid email address' },
    'gte':             { type: 'cross-field', comparator: '>=', errorMessage: 'Value must be ≥ dependent field' }
  }
};

// ─── Source Options ───────────────────────────────────────────────────────────

const SourceOptions = [
  'Walk-in', 'Phone Enquiry', 'Website', 'Social Media', 'Facebook Ads',
  'Google Ads', 'Referral', 'Agent Referral', 'Builder Referral',
  'Property Portal', '99acres', 'MagicBricks', 'Housing.com',
  'NoBroker', 'WhatsApp', 'SMS Campaign', 'Email Campaign',
  'Exhibition', 'Newspaper Ad', 'Outdoor Hoarding', 'Manual', 'Other'
];

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  EntityConfig,
  TagConfig,
  ScoringConfig,
  WorkflowConfig,
  ColumnConfig,
  V2FormRegistry,
  ValidationConfig,
  SourceOptions,
  FORM_REGISTRY_VERSION
};
