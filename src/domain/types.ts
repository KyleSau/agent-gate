// Domain model for the synthetic property-management dataset (data/seed.json).

export type WorkOrderStatus = "new" | "scheduled" | "in_progress" | "completed" | "cancelled";
export type Priority = "emergency" | "high" | "normal" | "low";

export interface Property { id: string; name: string; address: string }
export interface Unit { id: string; propertyId: string; number: string; bedrooms: number; residentId: string | null }
export interface Resident { id: string; firstName: string; lastName: string; email: string; phone: string; unitId: string }
export interface Vendor { id: string; name: string; trades: string[]; active: boolean }

export interface Lease {
  id: string;
  unitId: string;
  residentId: string;
  startDate: string;
  endDate: string;
  monthlyRent: number;
  balanceDue: number;
  status: "active" | "notice" | "expired";
}

export interface WorkOrder {
  id: string;
  unitId: string;
  residentId: string | null;
  category: string;
  priority: Priority | null;
  status: WorkOrderStatus;
  vendorId: string | null;
  createdAt: string;
  /** Resident-submitted free text. Untrusted: may contain PII or prompt-injection attempts. */
  description: string;
}

/**
 * One applied WRITE. Stored in the same file as the data it changed, so the change and
 * its undo record are committed by a single atomic rename and can never diverge.
 */
export interface JournalEntry {
  id: string;
  runId: string;
  approvalId: string;
  toolUseId: string;
  tool: string;
  workOrderId: string;
  before: Partial<WorkOrder>;
  after: Partial<WorkOrder>;
  appliedAt: string;
  rolledBackAt?: string;
}

export interface Db {
  _notice: string;
  properties: Property[];
  units: Unit[];
  residents: Resident[];
  leases: Lease[];
  vendors: Vendor[];
  workOrders: WorkOrder[];
  journal: JournalEntry[];
}
