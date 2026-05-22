// src/components/ReceiptCard.tsx
import { Link } from 'react-router-dom';

const ReceiptCard = ({
  receipt,
  actionLink,
  actionText,
  onMarkFinished,
}: {
  receipt: any;
  actionLink: string;
  actionText: string;
  onMarkFinished?: () => void;
}) => {
  return (
    <div className="border p-4 rounded-lg hover:shadow-md transition-shadow flex justify-between items-start">
      <div className="flex-1 pr-4">
        <h3 className="font-bold">{receipt.supplier || 'Unknown Supplier'}</h3>
        <p className="text-sm text-gray-600">
          {receipt.receiptDate || 'No date'} • {receipt.totalAmount || 'N/A'}
        </p>

        {receipt.items?.length > 0 && (
          <div className="mt-2">
            <p className="text-sm font-semibold">Items:</p>
            <ul className="text-sm text-gray-600">
              {receipt.items.slice(0, 2).map((item: any, index: number) => (
                <li key={index}>- {item.name}</li>
              ))}
              {receipt.items.length > 2 && (
                <li>+ {receipt.items.length - 2} more...</li>
              )}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 items-end">
        <Link
          to={actionLink}
          className="px-3 py-1 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
        >
          {actionText}
        </Link>
        {onMarkFinished && (
          <button
            onClick={onMarkFinished}
            className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
          >
            Mark as Finished
          </button>
        )}
      </div>
    </div>
  );
};

export default ReceiptCard;
