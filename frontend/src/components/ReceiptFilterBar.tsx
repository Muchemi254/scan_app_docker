  // Shared top-bar filter model (the "older" system).
  // Each page previously redeclared this inline with a bespoke subset.
  // Centralising the *type* and helpers here makes it cheap to extend the
  // backend-supported fields across all pages without touching each one.

export type TopFilterKey =
  | 'category'
  | 'supplier'
  | 'status'
  | 'batchTitle'
  | 'location'
  | 'invoiceNumber'
  | 'kraPin'
  | 'buyerKraPin'
  | 'cuInvoice'
  | 'entryType'
  | 'hasImage'
  | 'hasPdf'
  | 'rejected'
  | 'dateStart'
  | 'dateEnd'
  | 'scanDateStart'
  | 'scanDateEnd'
  | 'priceMin'
  | 'priceMax'
  | 'isZeroRated'
  | 'complete';

export type TopFilters = Partial<Record<TopFilterKey, string>> & {
  category?: string;
  supplier?: string;
  status?: string;
  batchTitle?: string;
  batch?: string; // admin Pending Approvals uses `batch` alias for batchTitle
};

export const TOP_FILTER_DEFAULTS: Required<Record<TopFilterKey, string>> = {
  category: '',
  supplier: '',
  status: '',
  batchTitle: '',
  location: '',
  invoiceNumber: '',
  kraPin: '',
  buyerKraPin: '',
  cuInvoice: '',
  entryType: '',
  hasImage: '',
  hasPdf: '',
  rejected: '',
  dateStart: '',
  dateEnd: '',
  scanDateStart: '',
  scanDateEnd: '',
  priceMin: '',
  priceMax: '',
  isZeroRated: '',
  complete: '',
};

export function buildTopFilterDefaults(overrides: TopFilters = {}): TopFilters {
  return { ...TOP_FILTER_DEFAULTS, ...overrides };
}

// Maps the shared top-filter keys to the backend query shapes used by
// receiptApi.list (filters) and receiptApi.search (dateFrom/dateTo, etc.).
// Pages call this instead of building their own `searchFilters` object.

export function toListFilters(top: TopFilters): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  if (top.category) out.category = top.category;
  if (top.supplier) out.supplier = top.supplier;
  if (top.status) out.status = top.status;
  if (top.batchTitle) out.batchTitle = top.batchTitle;
  if ((top as any).batch) out.batchTitle = (top as any).batch;
  if (top.location) out.location = top.location;
  if (top.invoiceNumber) out.invoiceNumber = top.invoiceNumber;
  if (top.kraPin) out.kraPin = top.kraPin;
  if (top.buyerKraPin) out.buyerKraPin = top.buyerKraPin;
  if (top.cuInvoice) out.cuInvoice = top.cuInvoice;
  if (top.entryType) out.entryType = top.entryType;
  if (top.hasImage) out.hasImage = top.hasImage as any;
  if (top.hasPdf) out.hasPdf = top.hasPdf as any;
  if (top.rejected) out.rejected = true as any;
  return out;
}

export function toSearchFilters(top: TopFilters): Record<string, string | number | boolean | undefined> {
  const base = toListFilters(top) as Record<string, any>;
  if (top.dateStart) base.dateFrom = top.dateStart;
  if (top.dateEnd) base.dateTo = top.dateEnd;
  if (top.scanDateStart) base.scanDateFrom = top.scanDateStart;
  if (top.scanDateEnd) base.scanDateTo = top.scanDateEnd;
  if (top.priceMin) base.priceMin = Number(top.priceMin);
  if (top.priceMax) base.priceMax = Number(top.priceMax);
  if (top.isZeroRated !== undefined && top.isZeroRated !== '') base.zeroRated = top.isZeroRated === 'true';
  if (top.complete !== undefined && top.complete !== '') base.complete = top.complete === 'true';
  return base;
}
