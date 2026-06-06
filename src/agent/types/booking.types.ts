export type BookingField =
  | "officeId"
  | "categoryId"
  | "startDateText"
  | "endDateText"
  | "driverAge";

export type GearType = "manual" | "automatic";

export type BookingDraft = {
  officeId?: string;
  officeName?: string;

  categoryId?: string;
  categoryName?: string;

  startDateText?: string;
  endDateText?: string;

  startDate?: string;
  endDate?: string;

  driverAge?: number;

  selectedGear?: GearType;

  addOns?: {
    addOnId: string;
    name: string;
    quantity: number;
    selectedTierIndex?: number;
  }[];

  customerPhone?: string;
  customerName?: string;

  confirmed?: boolean;
};

export type BookingAgentResult = {
  message: string;
  bookingDraft: BookingDraft;
  missingFields: BookingField[];
  isReadyForConfirmation: boolean;
};