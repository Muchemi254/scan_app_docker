// src/types/gemini.ts
export interface ResponseSchema {
  type: string;
  properties: Record<string, PropertySchema>;
  propertyOrdering?: string[];
  items?: {
    type: string;
    properties?: Record<string, PropertySchema>;
    propertyOrdering?: string[];
  };
}

export interface PropertySchema {
  type: string;
  description?: string;
  format?: string;
  items?: {
    type: string;
    properties?: Record<string, PropertySchema>;
    propertyOrdering?: string[];
  };
}

export interface ReceiptData {
  id: string;
  supplier: string;
  totalAmount: string;
  taxAmount: string;
  receiptDate: string;
  cuInvoice?: string;
  kraPin?: string;
  buyerKraPin?: string;
  invoiceNumber?: string;
  items: ReceiptItem[];
  category?: string;
  location?: string;
  taxRate?: string | null;
  imageUrl?: string;
  thumbnailUrl?: string;
  scannedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  batchTitle?: string;
}

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: string;
  tax?: string | null;
  taxRate?: string | null;
  isZeroRated?: boolean;
  discount?: string | null;
}

export interface GeminiResponse {
  candidates?: {
    content: {
      parts: {
        text: string;
      }[];
    };
  }[];
  error?: {
    message: string;
  };
}

export interface GeminiError {
  error: {
    code: number;
    message: string;
    status: string;
  };
}