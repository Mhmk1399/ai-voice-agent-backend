// ─────────────────────────────────────────────────────────────────────────────
// Context Provider Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface OfficeContext {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  status: string;
  workingDays?: WorkingDay[];
  specialDays?: SpecialDay[];
}

export interface WorkingDay {
  day: string; // e.g. "Monday"
  isOpen: boolean;
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
  pickupExtension?: TimeExtension;
  returnExtension?: TimeExtension;
}

export interface TimeExtension {
  enabled: boolean;
  startTime?: string;
  endTime?: string;
  flatPrice?: number;
}

export interface SpecialDay {
  month: number; // 1-12
  day: number; // 1-31
  isOpen: boolean;
  startTime?: string;
  endTime?: string;
  pickupTime?: string;
  returnTime?: string;
  pickupExtension?: TimeExtension;
  returnExtension?: TimeExtension;
  extraPrice?: number;
}

export interface PricingTier {
  minDays: number;
  maxDays: number;
  pricePerDay: number;
}

export interface GearInfo {
  availableTypes?: string[];
  automaticExtraCost?: number;
}

export interface CategoryContext {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  status: string;
  officeId?: string;
  typeId?: string;
  typeName?: string;
  showPrice?: number;
  selloffer?: number;
  extraHourRate?: number;
  pricingTiers?: PricingTier[];
  gear?: GearInfo;
  seats?: number;
  fuel?: string;
  minDriverAge?: number; // derived from type: 25 for minibus, 23 otherwise
}

export interface AddOnContext {
  id: string;
  name: string;
  description?: string;
  pricingType?: "flat" | "tiered";
  flatPrice?: {
    amount: number;
    isPerDay: boolean;
  };
  tieredPrice?: {
    tiers: Array<{ label: string; price: number; isPerDay: boolean }>;
  };
  status: string;
}

export interface BusinessContext {
  offices: OfficeContext[];
  categories: CategoryContext[];
  addOns: AddOnContext[];
  loadedAt: string; // ISO
}

export interface ContextProvider {
  load(): Promise<BusinessContext>;
  invalidate(): void;
}
