import { useState, useMemo, useEffect, useRef } from 'react';
import Decimal from 'decimal.js';
import { parseCurrencyToNumber } from '../utils/helpers';

const DEFAULT_TAX_RATE = 16;

const ReceiptForm = ({
  initialData,
  onSubmit,
  onImageChange,
  loading,
}: {
  initialData: any;
  onSubmit: (data: any) => void;
  onImageChange: (file: File | null) => void;
  loading: boolean;
}) => {
  const [formData, setFormData] = useState(() => ({
    supplier: initialData?.supplier || '',
    totalAmount: initialData?.totalAmount || '',
    taxAmount: initialData?.taxAmount || '',
    receiptDate: initialData?.receiptDate || '',
    category: initialData?.category || '',
    invoiceNumber: initialData?.invoiceNumber || '',
    kraPin: initialData?.kraPin || '',
    buyerKraPin: initialData?.buyerKraPin || '',
    cuInvoice: initialData?.cuInvoice || '',
    status: initialData?.status || 'processed',
    items: initialData?.items?.length
      ? initialData.items.map((item: any) => ({
          ...item,
          tax: item.tax || '',
          discount: item.discount || '',
          isZeroRated: item.isZeroRated || false,
        }))
      : [],
  }));

  const [taxAdded, setTaxAdded] = useState(false);
  const [taxSplit, setTaxSplit] = useState(false);
  const [originalItems, setOriginalItems] = useState<any[]>([]);
  const [itemOriginalStates, setItemOriginalStates] = useState<{[key: number]: any}>({});
  const [openActionIndex, setOpenActionIndex] = useState<number | null>(null);
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (actionRef.current && !actionRef.current.contains(e.target as Node)) {
        setOpenActionIndex(null);
      }
    };
    if (openActionIndex !== null) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openActionIndex]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData({ ...formData, [name]: value });
  };

  // Sync form state when initialData loads (async fetch completes after mount)
  useEffect(() => {
    if (initialData) {
      setFormData({
        supplier: initialData.supplier || '',
        totalAmount: initialData.totalAmount || '',
        taxAmount: initialData.taxAmount || '',
        receiptDate: initialData.receiptDate || '',
        category: initialData.category || '',
        invoiceNumber: initialData.invoiceNumber || '',
        kraPin: initialData.kraPin || '',
        buyerKraPin: initialData.buyerKraPin || '',
        cuInvoice: initialData.cuInvoice || '',
        status: initialData.status || 'processed',
        items: initialData.items?.length
          ? initialData.items.map((item: any) => ({
              ...item,
              tax: item.tax || '',
              discount: item.discount || '',
              isZeroRated: item.isZeroRated || false,
            }))
          : [],
      });
    }
  }, [initialData]);

  const handleItemChange = (index: number, field: string, value: string | number | boolean) => {
    const newItems = [...formData.items];
    newItems[index] = { ...newItems[index], [field]: value };

    if (field === 'isZeroRated' && value === true) {
      newItems[index].tax = '0';
    }

    setFormData({ ...formData, items: newItems });
  };

  const handleAddItem = () => {
    setFormData({
      ...formData,
      items: [...formData.items, {
        name: '',
        quantity: 1,
        price: '',
        tax: '',
        discount: '',
        isZeroRated: false
      }],
    });
  };

  const handleDuplicateItem = (index: number) => {
    const item = formData.items[index];
    const newItems = [...formData.items];
    newItems.splice(index + 1, 0, { ...item });
    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);
  };

  const handleRemoveItem = (index: number) => {
    const newItems = formData.items.filter((_, i) => i !== index);
    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);

    setItemOriginalStates(prev => {
      const newStates: {[key: number]: any} = {};
      Object.keys(prev).forEach(key => {
        const keyIndex = parseInt(key);
        if (keyIndex < index) {
          newStates[keyIndex] = prev[keyIndex];
        } else if (keyIndex > index) {
          newStates[keyIndex - 1] = prev[keyIndex];
        }
      });
      return newStates;
    });
  };

  const handleSubmit = (e: React.FormEvent, statusOverride?: string) => {
    e.preventDefault();

    if (formData.taxAmount) {
      const calculatedTax = formData.items.reduce((sum, item) => {
        const quantity = new Decimal(item.quantity || 0);
        const tax = new Decimal(parseCurrencyToNumber(item.tax));
        return sum.plus(quantity.mul(tax));
      }, new Decimal(0)).toNumber();

      const formTaxAmount = parseCurrencyToNumber(formData.taxAmount);
      const taxVariance = Math.abs(calculatedTax - formTaxAmount);

      if (taxVariance > 0.01 && taxVariance <= 0.05) {
        console.warn(`Minor tax mismatch: ${taxVariance.toFixed(3)} allowed.`);
      }
    }

    const sanitizedData = {
      ...formData,
      status: statusOverride || formData.status,
      items: formData.items.map(({ name, quantity, price, tax, discount, isZeroRated }) => ({
        name,
        quantity,
        price: new Decimal(parseCurrencyToNumber(price)).toDecimalPlaces(3).toString(),
        tax: tax ? new Decimal(parseCurrencyToNumber(tax)).toDecimalPlaces(3).toString() : '0',
        discount: discount || null,
        isZeroRated
      })),
    };
    onSubmit(sanitizedData);
  };

  const itemsTotal = useMemo(() => {
    return formData.items.reduce((sum, item) => {
      const quantity = new Decimal(item.quantity || 0);
      const price = new Decimal(parseCurrencyToNumber(item.price));
      const tax = new Decimal(parseCurrencyToNumber(item.tax));
      const discountPct = new Decimal(parseCurrencyToNumber(item.discount));
      const subtotal = quantity.mul(price.plus(tax));
      const discountFactor = discountPct.gt(0)
        ? new Decimal(1).minus(discountPct.div(100))
        : new Decimal(1);
      return sum.plus(subtotal.mul(discountFactor).toDecimalPlaces(3));
    }, new Decimal(0)).toNumber();
  }, [formData.items]);

  const numericTotalAmount = parseCurrencyToNumber(formData.totalAmount);
  const variance = new Decimal(numericTotalAmount).minus(itemsTotal).toDecimalPlaces(3).toNumber();

  // Bulk operations
  const handleAddTax = () => {
    if (!taxAdded) setOriginalItems([...formData.items]);

    const updatedItems = formData.items.map((item) => {
      if (item.isZeroRated) return item;

      const price = parseFloat(item.price) || 0;
      const tax = new Decimal(price).mul(DEFAULT_TAX_RATE).div(100).toDecimalPlaces(3).toNumber();
      return { ...item, tax: tax.toString() };
    });

    setFormData({ ...formData, items: updatedItems });
    setTaxAdded(!taxAdded);

    if (taxAdded) {
      setFormData({ ...formData, items: originalItems });
    }
  };

  const handleSplitTax = () => {
    if (!taxSplit) setOriginalItems([...formData.items]);

    const updatedItems = formData.items.map((item) => {
      if (item.isZeroRated) return item;

      const fullPrice = parseFloat(item.price) || 0;
      const fullPriceDecimal = new Decimal(fullPrice);
      const priceWithoutTax = fullPriceDecimal.div(new Decimal(1).plus(DEFAULT_TAX_RATE / 100));
      const tax = fullPriceDecimal.minus(priceWithoutTax);

      return {
        ...item,
        price: priceWithoutTax.toDecimalPlaces(3).toString(),
        tax: tax.toDecimalPlaces(3).toString(),
      };
    });

    setFormData({ ...formData, items: updatedItems });
    setTaxSplit(!taxSplit);

    if (taxSplit) {
      setFormData({ ...formData, items: originalItems });
    }
  };

  const handleBulkZeroTax = () => {
    const updatedItems = formData.items.map((item) => ({
      ...item,
      tax: '0',
      isZeroRated: true
    }));

    setFormData({ ...formData, items: updatedItems });
  };

  const handleBulkDiscount = () => {
    const pct = window.prompt('Enter discount percentage for all items:');
    if (pct === null) return;
    const num = parseFloat(pct);
    if (isNaN(num) || num < 0 || num > 100) {
      alert('Please enter a valid percentage (0–100).');
      return;
    }
    const updatedItems = formData.items.map((item) => ({
      ...item,
      discount: num === 0 ? '' : num.toString(),
    }));
    setFormData({ ...formData, items: updatedItems });
  };

  // Individual item operations
  const saveItemOriginalState = (index: number) => {
    if (!itemOriginalStates[index]) {
      const item = formData.items[index];
      setItemOriginalStates(prev => ({
        ...prev,
        [index]: {
          price: item.price,
          tax: item.tax,
          discount: item.discount,
          isZeroRated: item.isZeroRated
        }
      }));
    }
  };

  const handleIndividualAddTax = (index: number) => {
    const item = formData.items[index];
    if (item.isZeroRated) return;

    saveItemOriginalState(index);

    const price = parseCurrencyToNumber(item.price);
    const tax = new Decimal(price).mul(DEFAULT_TAX_RATE).div(100).toDecimalPlaces(3).toNumber();

    const newItems = [...formData.items];
    newItems[index] = { ...newItems[index], tax: tax.toString() };

    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);
  };

  const handleIndividualSplitTax = (index: number) => {
    const item = formData.items[index];
    if (item.isZeroRated) return;

    saveItemOriginalState(index);

    const fullPrice = parseCurrencyToNumber(item.price);
    const fullPriceDecimal = new Decimal(fullPrice);
    const priceWithoutTax = fullPriceDecimal.div(new Decimal(1).plus(DEFAULT_TAX_RATE / 100));
    const tax = fullPriceDecimal.minus(priceWithoutTax);

    const newItems = [...formData.items];
    newItems[index] = {
      ...newItems[index],
      price: priceWithoutTax.toDecimalPlaces(3).toString(),
      tax: tax.toDecimalPlaces(3).toString(),
    };

    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);
  };

  const handleIndividualZeroTax = (index: number) => {
    saveItemOriginalState(index);

    const newItems = [...formData.items];
    newItems[index] = {
      ...newItems[index],
      tax: '0',
      isZeroRated: true
    };

    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);
  };

  const handleIndividualDiscount = (index: number) => {
    saveItemOriginalState(index);

    const pct = window.prompt('Enter discount percentage for this item:');
    if (pct === null) return;
    const num = parseFloat(pct);
    if (isNaN(num) || num < 0 || num > 100) {
      alert('Please enter a valid percentage (0–100).');
      return;
    }

    const newItems = [...formData.items];
    newItems[index] = {
      ...newItems[index],
      discount: num === 0 ? '' : num.toString(),
    };

    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);
  };

  const handleIndividualReset = (index: number) => {
    const originalState = itemOriginalStates[index];
    if (!originalState) return;

    const newItems = [...formData.items];
    newItems[index] = {
      ...newItems[index],
      price: originalState.price,
      tax: originalState.tax,
      discount: originalState.discount,
      isZeroRated: originalState.isZeroRated
    };

    setFormData({ ...formData, items: newItems });
    setOpenActionIndex(null);

    setItemOriginalStates(prev => {
      const newStates = { ...prev };
      delete newStates[index];
      return newStates;
    });
  };

  const itemCount = formData.items.length;

  // Grid: Name | Qty | Price | Tax | Disc% | Total | Actions
  const gridCols = 'grid-cols-[1fr_52px_72px_64px_44px_72px_28px]';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {["supplier", "totalAmount", "taxAmount", "receiptDate", "category", "invoiceNumber", "kraPin", "buyerKraPin", "cuInvoice"].map((name) => (
          <div key={name}>
            <label className="block text-xs font-medium text-gray-600 mb-0.5 capitalize">{name.replace(/([A-Z])/g, ' $1')}</label>
            <input
              type="text"
              name={name}
              value={(formData as any)[name]}
              onChange={handleChange}
              className="w-full px-2 py-1 border rounded text-sm"
              required={name === 'supplier' || name === 'totalAmount'}
            />
          </div>
        ))}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-0.5">Receipt Image</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onImageChange(e.target.files?.[0] || null)}
            className="w-full px-2 py-1 border rounded text-sm"
          />
        </div>
      </div>

      {/* Items section */}
      <div className="mt-4">
        <div className="flex justify-between items-center mb-1">
          <h3 className="font-semibold text-sm">Items {itemCount > 0 && `(${itemCount})`}</h3>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleAddTax}
              className={`text-xs px-2 py-0.5 rounded border ${taxAdded ? 'bg-blue-500 text-white border-blue-500' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
            >
              {taxAdded ? 'Undo Add Tax' : 'Bulk: Add Tax'}
            </button>
            <button
              type="button"
              onClick={handleSplitTax}
              className={`text-xs px-2 py-0.5 rounded border ${taxSplit ? 'bg-green-600 text-white border-green-600' : 'bg-white border-gray-300 hover:bg-gray-100'}`}
            >
              {taxSplit ? 'Undo Split' : 'Bulk: Split Tax'}
            </button>
            <button
              type="button"
              onClick={handleBulkZeroTax}
              className="text-xs px-2 py-0.5 rounded border bg-white border-gray-300 hover:bg-yellow-100"
            >
              Bulk: Zero Tax
            </button>
            <button
              type="button"
              onClick={handleBulkDiscount}
              className="text-xs px-2 py-0.5 rounded border bg-white border-pink-300 text-pink-700 hover:bg-pink-50"
            >
              Bulk: Discount
            </button>
          </div>
        </div>

        {/* Column headers */}
        {itemCount > 0 && (
          <div className={`grid ${gridCols} gap-1 px-1.5 py-0.5 border-b-2 border-gray-300 text-xs text-gray-500 font-medium`}>
            <span>Name</span>
            <span className="text-right">Qty</span>
            <span className="text-right">Price</span>
            <span className="text-right">Tax</span>
            <span className="text-right">Disc%</span>
            <span className="text-right">Total</span>
            <span></span>
          </div>
        )}

        {/* Item rows */}
        {formData.items.map((item, index) => {
          const quantity = new Decimal(item.quantity || 0);
          const price = new Decimal(parseCurrencyToNumber(item.price));
          const tax = new Decimal(parseCurrencyToNumber(item.tax));
          const discountPct = new Decimal(parseCurrencyToNumber(item.discount));
          const subtotal = quantity.mul(price.plus(tax));
          const discountFactor = discountPct.gt(0)
            ? new Decimal(1).minus(discountPct.div(100))
            : new Decimal(1);
          const total = subtotal.mul(discountFactor);
          const isModified = !!itemOriginalStates[index];
          const hasDiscount = discountPct.gt(0);

          return (
            <div
              key={index}
              className={`grid ${gridCols} gap-1 items-center px-1.5 py-0.5 border-b hover:bg-blue-50/50 transition-colors ${isModified ? 'bg-yellow-50' : ''}`}
            >
              <input
                type="text"
                placeholder="Item name"
                value={item.name}
                onChange={(e) => handleItemChange(index, 'name', e.target.value)}
                className="w-full px-1.5 py-1 border-0 border-b border-gray-200 rounded-none text-sm focus:outline-none focus:border-blue-400 bg-transparent"
              />
              <input
                type="number"
                value={item.quantity}
                onChange={(e) => handleItemChange(index, 'quantity', e.target.value)}
                className="w-full px-1.5 py-1 border-0 border-b border-gray-200 rounded-none text-sm text-right focus:outline-none focus:border-blue-400 bg-transparent"
                min="0.01"
                step="0.01"
              />
              <input
                type="text"
                placeholder="0.00"
                value={item.price}
                onChange={(e) => handleItemChange(index, 'price', e.target.value)}
                className="w-full px-1.5 py-1 border-0 border-b border-gray-200 rounded-none text-sm text-right focus:outline-none focus:border-blue-400 bg-transparent"
              />
              <input
                type="text"
                placeholder="0.00"
                value={item.tax || ''}
                onChange={(e) => handleItemChange(index, 'tax', e.target.value)}
                disabled={item.isZeroRated}
                className={`w-full px-1.5 py-1 border-0 border-b border-gray-200 rounded-none text-sm text-right focus:outline-none focus:border-blue-400 bg-transparent ${item.isZeroRated ? 'text-gray-400 italic' : ''}`}
                title={item.isZeroRated ? 'Zero-rated' : ''}
              />
              <input
                type="text"
                placeholder="—"
                value={item.discount || ''}
                onChange={(e) => handleItemChange(index, 'discount', e.target.value)}
                className={`w-full px-1 py-1 border-0 border-b rounded-none text-sm text-right focus:outline-none focus:border-pink-400 bg-transparent ${hasDiscount ? 'border-pink-200 text-pink-700 font-medium' : 'border-gray-200 text-gray-500'}`}
                title="Discount percentage"
              />
              <span className={`text-xs text-right font-mono tabular-nums px-1 ${hasDiscount ? 'text-pink-700 font-medium' : ''}`}>
                {total.toFixed(2)}
              </span>

              {/* Actions */}
              <div className="relative flex justify-center" ref={openActionIndex === index ? actionRef : undefined}>
                <button
                  type="button"
                  onClick={() => setOpenActionIndex(openActionIndex === index ? null : index)}
                  className={`w-6 h-6 flex items-center justify-center rounded text-sm leading-none transition-colors ${openActionIndex === index ? 'bg-gray-200' : 'hover:bg-gray-100 text-gray-500'}`}
                  title="Actions"
                >
                  ⋮
                </button>

                {openActionIndex === index && (
                  <div className="absolute right-0 top-full mt-0.5 z-20 bg-white border rounded shadow-lg py-1 w-36 text-xs">
                    {!item.isZeroRated && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleIndividualAddTax(index)}
                          className="w-full text-left px-3 py-1.5 hover:bg-blue-50 text-blue-700"
                        >
                          Add Tax (16%)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleIndividualSplitTax(index)}
                          className="w-full text-left px-3 py-1.5 hover:bg-green-50 text-green-700"
                        >
                          Split Tax
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => handleIndividualZeroTax(index)}
                      className="w-full text-left px-3 py-1.5 hover:bg-yellow-50 text-yellow-700"
                    >
                      Zero Tax
                    </button>
                    <button
                      type="button"
                      onClick={() => handleIndividualDiscount(index)}
                      className="w-full text-left px-3 py-1.5 hover:bg-pink-50 text-pink-700"
                    >
                      Discount…
                    </button>
                    {isModified && (
                      <button
                        type="button"
                        onClick={() => handleIndividualReset(index)}
                        className="w-full text-left px-3 py-1.5 hover:bg-orange-50 text-orange-700 border-t"
                      >
                        Reset
                      </button>
                    )}
                    <div className="border-t my-0.5" />
                    <button
                      type="button"
                      onClick={() => handleDuplicateItem(index)}
                      className="w-full text-left px-3 py-1.5 hover:bg-gray-100"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveItem(index)}
                      className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleAddItem}
          className="mt-1 px-2 py-1 border border-dashed border-gray-300 rounded text-xs text-gray-500 hover:border-gray-400 hover:text-gray-700 hover:bg-gray-50 w-full text-left"
        >
          + Add item
        </button>

        {/* Totals summary */}
        {itemCount > 0 && (
          <div className="mt-3 p-2 bg-gray-50 border rounded text-xs">
            <div className="flex justify-between gap-4">
              <span><strong>Items Total (incl. tax & discounts):</strong> {itemsTotal.toFixed(3)}</span>
              <span><strong>Form Total:</strong> {formData.totalAmount || '—'}</span>
              <span className={Math.abs(Number(variance)) > 0.005 ? 'text-red-600' : 'text-green-600'}>
                <strong>Variance:</strong> {variance.toFixed(3)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Submit buttons */}
      <div className="flex gap-2 mt-4">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 disabled:bg-gray-400 font-medium transition-colors"
        >
          {loading ? 'Saving...' : 'Save Changes'}
        </button>

        {formData.status === 'needs_review' && (
          <button
            type="button"
            disabled={loading}
            onClick={(e) => handleSubmit(e, 'processed')}
            className="px-4 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:bg-gray-400 font-medium transition-colors"
          >
            {loading ? 'Saving...' : 'Save as Processed'}
          </button>
        )}
      </div>
    </form>
  );
};

export default ReceiptForm;