// src/components/ExportModal.tsx
import { exportToExcel, exportToPDF } from '../services/export';

interface ExportModalProps {
  receipts: any[];
  onClose: () => void;
  fileName?: string;
}

const allowedFields = [
  'id',
  'receiptDate',
  'supplier',
  'invoiceNumber',
  'totalAmount',
  'taxAmount',
  'category',
  'kraPin',
  'cuInvoice',
];

function parseDateMDY(dateStr: string): Date | string {
  if (!dateStr) return '';
  const parts = String(dateStr).split('/');
  if (parts.length === 3) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000) {
      return new Date(y, m - 1, d);
    }
  }
  return dateStr;
}

const flattenReceipts = (receipts: any[]) => {
  const rows: any[] = [];

  receipts.forEach(receipt => {
    const raw = Object.fromEntries(
      allowedFields.map(field => [field, receipt[field] || ''])
    );
    const base: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      base[k === 'id' ? 'Receipt ID' : k] = v;
    }
    // Convert receiptDate to proper Date for Excel
    base['receiptDate'] = parseDateMDY(base['receiptDate']);

    if (Array.isArray(receipt.items) && receipt.items.length > 0) {
      receipt.items.forEach((item: any) => {
        const quantity = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.price) || 0;
        const tax = parseFloat(item.tax) || 0;
        const isZeroRated = item.isZeroRated === true;
        const itemTotal = quantity * (price + tax);

        rows.push({
          ...base,
          'Item Name': item.name || '',
          'Quantity': quantity,
          'Price': Number(price.toFixed(3)),
          'Tax': Number(tax.toFixed(3)),
          'Zero Rated': isZeroRated,
          'Total': Number(itemTotal.toFixed(3)),
        });
      });
    } else {
      rows.push({
        ...base,
        'Item Name': '',
        'Quantity': '',
        'Price': '',
        'Tax': '',
        'Zero Rated': '',
        'Total': '',
      });
    }
  });

  return rows;
};

const ExportModal = ({ receipts, onClose, fileName = 'filtered_receipts' }: ExportModalProps) => {
  const rows = flattenReceipts(receipts);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg max-w-md w-full shadow-lg relative">
        <h3 className="text-lg font-bold mb-2">Export Filtered Receipts</h3>
        <p className="text-sm text-gray-600 mb-4">
          {receipts.length} receipts will be exported.
        </p>
        <div className="flex gap-4">
          <button
            onClick={() => {
              exportToExcel(rows, `${fileName}.xlsx`);
              onClose();
            }}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Export Excel
          </button>
          <button
            onClick={() => {
              exportToPDF(rows, `${fileName}.pdf`);
              onClose();
            }}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Export PDF
          </button>
        </div>
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-400 hover:text-black"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

export default ExportModal;
