// src/components/ExportModal.tsx
import { exportToExcel, exportToPDF } from '../services/export';

interface ExportModalProps {
  receipts: any[];
  onClose: () => void;
  fileName?: string;
}

const ExportModal = ({ receipts, onClose, fileName = 'filtered_receipts' }: ExportModalProps) => {
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
              exportToExcel(receipts, 'detailed', { title: fileName, pivotConfig: undefined });
              onClose();
            }}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            Export Excel
          </button>
          <button
            onClick={() => {
              exportToPDF(receipts, 'detailed', { title: fileName, pivotConfig: undefined });
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
