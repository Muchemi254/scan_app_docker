/**
 * Receipt review → approval pipeline status helpers (shared across UI).
 *
 *   needs_review → pending_approval → processed
 */

export type ReceiptStatusCode = 'needs_review' | 'pending_approval' | 'processed';

export const RECEIPT_STATUS_LABELS: Record<string, string> = {
  needs_review: 'Needs Review',
  pending_approval: 'Pending Approval',
  processed: 'Processed',
};

export const RECEIPT_STATUS_CLASSES: Record<string, string> = {
  needs_review: 'bg-yellow-100 text-yellow-700',
  pending_approval: 'bg-blue-100 text-blue-700',
  processed: 'bg-green-100 text-green-700',
};

export function receiptStatusLabel(status?: string | null): string {
  return RECEIPT_STATUS_LABELS[status || 'needs_review'] || status || 'Needs Review';
}

export function receiptStatusClass(status?: string | null): string {
  return RECEIPT_STATUS_CLASSES[status || 'needs_review'] || 'bg-gray-100 text-gray-600';
}
