import { AlertTriangle, FileText } from 'lucide-react';

interface DuplicateMatch {
  id: string;
  supplier: string;
  totalAmount: string;
  receiptDate: string;
  invoiceNumber?: string;
  confidence: string;
}

interface DuplicateWarningProps {
  matches: DuplicateMatch[];
  onContinue: () => void;
  onCancel: () => void;
}

const DuplicateWarning = ({ matches, onContinue, onCancel }: DuplicateWarningProps) => {
  const highConfidence = matches.filter(m => m.confidence === 'high');
  const mediumConfidence = matches.filter(m => m.confidence === 'medium');

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 animate-in zoom-in-95 duration-200">
        <div className="flex items-center gap-3 text-amber-600 mb-4">
          <AlertTriangle className="h-6 w-6" />
          <h3 className="text-xl font-bold text-gray-900">Possible Duplicate Detected</h3>
        </div>

        <p className="text-gray-600 text-sm mb-4">
          This receipt appears similar to existing entries. Review the matches below before saving.
        </p>

        {highConfidence.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-2">High Confidence Matches</p>
            <div className="space-y-2">
              {highConfidence.map(m => (
                <div key={m.id} className="border border-red-200 bg-red-50 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                    <FileText className="h-3.5 w-3.5" />
                    {m.supplier}
                  </div>
                  <div className="text-xs text-red-600 mt-1 space-y-0.5">
                    <div>Amount: {m.totalAmount} — Date: {m.receiptDate}</div>
                    {m.invoiceNumber && <div>Invoice: {m.invoiceNumber}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {mediumConfidence.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-2">Possible Matches</p>
            <div className="space-y-2">
              {mediumConfidence.map(m => (
                <div key={m.id} className="border border-amber-200 bg-amber-50 rounded-lg p-3">
                  <div className="text-sm font-semibold text-amber-700">{m.supplier}</div>
                  <div className="text-xs text-amber-600 mt-1">
                    Amount: {m.totalAmount} — Date: {m.receiptDate}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            Review Again
          </button>
          <button
            onClick={onContinue}
            className="flex-1 px-4 py-2.5 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 transition-colors"
          >
            Save Anyway
          </button>
        </div>
      </div>
    </div>
  );
};

export default DuplicateWarning;
