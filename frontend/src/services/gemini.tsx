// src/services/gemini.ts
import type { ResponseSchema, ReceiptData, GeminiResponse } from '../types/gemini';
import { handleApiError, getUserMessage } from './apiErrorHandler';

// Pricing for Gemini models (per 1M tokens)
const MODEL_PRICING = {
  'gemini-2.5-flash': { input: 0.075, cachedInput: 0.0225, output: 0.3 },
  'gemini-1.5-flash': { input: 0.075, cachedInput: 0.0225, output: 0.3 },
};

// Cost tracking
let totalCost = 0;
export const getCostSummary = () => totalCost.toFixed(4);

const logCost = (tokens: number, type: 'input' | 'output' | 'cached', model: string) => {
  const rate = MODEL_PRICING[model as keyof typeof MODEL_PRICING];
  if (!rate) return;

  const cost = type === 'cached'
    ? (tokens * rate.cachedInput) / 1_000_000
    : (tokens * rate[type]) / 1_000_000;

  totalCost += cost;
  console.log(`💰 Token usage: ${tokens} ${type} tokens (${type === 'cached' ? 'cached' : type}), Cost: $${cost.toFixed(6)}`);
};

/**
 * Helper to validate and clean Gemini's JSON response
 * @param text Raw response text from Gemini
 * @returns Parsed JSON object
 * @throws Error if parsing fails
 */

const normalizeDateStrict = (raw: string): string => {
  if (!raw || raw === 'N/A') {
    throw new Error('Missing receipt date');
  }

  // Already correct
  if (/^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/.test(raw)) {
    return raw;
  }

  // Allow dash variant → normalize to slash
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) {
    throw new Error(`Invalid date format: ${raw}`);
  }

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);

  // Reject ambiguity and invalids
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${raw}`);
  }
  if (day < 1 || day > 31) {
    throw new Error(`Invalid day: ${raw}`);
  }

  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
};

const sanitizePrice = (val: any): string => {
  if (typeof val === 'number') return val.toFixed(2);
  if (typeof val !== 'string') return '';

  let cleaned = val.replace(/[^\d.,]/g, '');

  // Remove thousand separators if both . and , exist
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '');
  }

  cleaned = cleaned.replace(/:/g, '.'); // Fix colon errors

  const num = parseFloat(cleaned);
  return isNaN(num) ? '' : num.toFixed(2);
};

const parseGeminiResponse = (text: string): ReceiptData => {
  try {
    // Remove markdown code block notation if present
    const cleanText = text.replace(/^```json|```$/g, '').trim();
    const parsed = JSON.parse(cleanText);
    
    // Validate basic structure
    if (!parsed.supplier || !parsed.totalAmount) {
      throw new Error("Missing required fields in response");
    }
    
    return {
      id: parsed.id || '',
      supplier: parsed.supplier,
      totalAmount: sanitizePrice(parsed.totalAmount),
      taxAmount: sanitizePrice(parsed.taxAmount),
      receiptDate: normalizeDateStrict(parsed.receiptDate),
      cuInvoice: parsed.cuInvoice || 'N/A',
      kraPin: parsed.kraPin || 'N/A',
      invoiceNumber: parsed.invoiceNumber || 'N/A',
      category: parsed.category || 'Other', // Include category in response
      items: Array.isArray(parsed.items) 
        ? parsed.items.map((item: any) => ({
        name: item.name || 'N/A',
        quantity: Number(item.quantity) || 1,
        price: sanitizePrice(item.price)
      }))
      : []
    };
  } catch (error) {
    console.error("Failed to parse Gemini response:", text);
    throw new Error(`Invalid response from Gemini: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Extracts structured receipt data AND suggests category from an image using Gemini AI
 * @param base64Image Image data in base64 format
 * @param mimeType MIME type of the image (e.g., 'image/jpeg')
 * @returns Promise resolving to parsed receipt data with category
 * @throws Error if extraction fails
 */
export const extractReceiptData = async (
  base64Image: string,
  mimeType: string
): Promise<ReceiptData> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    const error = new Error('Missing Gemini API key - VITE_GEMINI_API_KEY not configured');
    const apiError = handleApiError(error, 'extractReceiptData');
    throw new Error(getUserMessage(apiError));
  }

  const responseSchema: ResponseSchema = {
    type: "OBJECT",
    properties: {
      supplier: { 
        type: "STRING",
        description: "Name of the supplier/store" 
      },
      totalAmount: { 
        type: "STRING",
        description: "Total amount including currency symbol if present" 
      },
      taxAmount: { 
        type: "STRING",
        description: "Tax amount if available" 
      },
      receiptDate: { 
        type: "STRING",
        description: "Date in MM/DD/YYYY format" 
      },
      cuInvoice: { 
        type: "STRING",
        description: "CU invoice number if available" 
      },
      kraPin: { 
        type: "STRING",
        description: "KRA PIN if available" 
      },
      invoiceNumber: { 
        type: "STRING",
        description: "Generic invoice number if available" 
      },
      category: {
        type: "STRING",
        description: "Category based on supplier and items - must be EXACTLY one of the predefined categories"
      },
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { 
              type: "STRING",
              description: "Name of the item" 
            },
            quantity: { 
              type: "NUMBER",
              description: "Quantity purchased" 
            },
            price: { 
              type: "STRING",
              description: "Price per unit including currency if present" 
            }
          }
        }
      }
    },
    propertyOrdering: [
      "supplier",
      "totalAmount",
      "taxAmount",
      "receiptDate",
      "category",
      "items"
    ]
  };

  // Reusable cached category list (will be cached by Gemini)
  // Canonical taxonomy — keep identical to backend/app/services/gemini.py CATEGORIES
const CATEGORY_LIST = [
  "Building Materials", "Hardware & Tools", "Paint & Finishes", "Plumbing & Sanitary", "Electrical Supplies", "Security & Surveillance",
  "Fuel & Lubricants", "Vehicle Maintenance", "Transport Services", "Utilities & Bills",
  "Seeds & Inputs", "Fertilizers & Chemicals", "Farm Tools & Equipment", "Greenhouse Supplies",
  "Crop Harvesting & Processing", "Agro Consultancy & Training",
  "Animal Feed & Supplements", "Livestock & Poultry", "Veterinary Services",
  "Food & Groceries", "Furniture & Fixtures", "Utensils & Cutlery", "Cleaning Supplies", "Baby & Kids Supplies",
  "Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine",
  "Stationery & Office Supplies", "Professional & Business Services", "Employee Salaries & Wages",
  "Licenses & Permits", "Rent, Lease & Property",
  "Electronics & Appliances", "Phones & Accessories", "Computers & IT Equipment",
  "Raw Materials", "Packaging Supplies", "Gifts & Donations", "Entertainment & Leisure",
  "Repairs & Maintenance", "Emergency Purchases", "Other"
];

const categoryInstructions = `
For the category field, analyze the supplier name and items, then choose EXACTLY ONE category from this list:

${CATEGORY_LIST.join('", "')}

Return the EXACT category name from the list above.`;

  const payload = {
    contents: [{
      role: "user",
      parts: [
        { 
          text: `Extract receipt details from this image and categorize it. Return only JSON matching the provided schema.

INSTRUCTIONS:
- For amounts, include currency symbols if present
- For missing fields, use 'N/A'
- Ensure dates are in MM/DD/YYYY format if possible
- ${categoryInstructions}`
        },
        { 
          inlineData: {
            mimeType,
            data: base64Image
          }
        }
      ]
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.1 // Lower temperature for more consistent results
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const errorData: GeminiResponse = await response.json();
      throw new Error(errorData.error?.message || `API request failed with status ${response.status}`);
    }

    const result: GeminiResponse = await response.json();
    const responseText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      throw new Error("No text content in Gemini response");
    }

    // Log token usage if available
    if ((result as any).usageMetadata) {
      const usage = (result as any).usageMetadata;
      logCost(usage.promptTokens || 0, 'input', 'gemini-2.5-flash');
      logCost(usage.cacheReadTokens || 0, 'cached', 'gemini-2.5-flash');
      logCost(usage.outputTokens || 0, 'output', 'gemini-2.5-flash');
    }

    return parseGeminiResponse(responseText);
  } catch (error) {
    const apiError = handleApiError(error, 'extractReceiptData');
    // Throw user-friendly message, detailed error is logged by handleApiError
    throw new Error(getUserMessage(apiError));
  }
};

/**
 * Suggests a category for a receipt based on supplier and items
 * @param supplier Name of the supplier
 * @param items Array of receipt items
 * @returns Promise resolving to suggested category string
 * @deprecated Use extractReceiptData instead - now includes categorization
 */
/*
export const suggestCategory = async (
  supplier: string,
  items: ReceiptItem[]
): Promise<string> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing Gemini API key");

  const itemText = items
    .map(item => item.name)
    .filter(Boolean)
    .join(", ") || "N/A";

  const prompt = `Categorize this receipt in exactly one word based on the supplier and items.
Only choose one of the following categories (do not return anything else):

"Building Materials", "Hardware & Tools", "Paint & Finishes", "Plumbing & Sanitary", "Electrical Supplies",
"Fuel & Lubricants", "Vehicle Maintenance", "Transport Services", "Energy & Utilities",
"Seeds & Inputs", "Fertilizers & Chemicals", "Irrigation Supplies", "Farm Tools & Equipment",
"Animal Feed & Supplements", "Veterinary Services", "Livestock & Poultry",
"Crop Harvesting & Processing", "Greenhouse Supplies", "Agro Consultancy & Training",
"Furniture & Fixtures", "Electronics & Appliances", "Utensils & Cutlery",
"Cleaning Supplies", "Stationery & Office Supplies",
"Groceries & Provisions", "Perishables", "Beverages", "Restaurant & Catering",
"Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine", "Baby & Kids Supplies",
"Phones & Accessories", "Computers & IT Equipment", "Internet & Airtime",
"Gifts & Donations", "Entertainment & Leisure", "Education & Learning", "Subscriptions & Memberships",
"Raw Materials", "Packaging Supplies", "Marketing & Branding", "Employee Salaries & Wages",
"Professional Services", "Licenses & Permits",
"Rent & Lease", "Land & Property Purchases", "Security & Surveillance",
"Repairs & Maintenance", "Emergency Purchases"

Supplier: ${supplier}
Items: ${itemText}

Return ONLY the exact category name (copy-paste from list above).`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 10
          }
        })
      }
    );

    const result: GeminiResponse = await response.json();
    const category = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    console.log("🧠 Gemini raw category response:", category);

    const validCategories: string[] = [ 
      "Building Materials", "Hardware & Tools", "Paint & Finishes", "Plumbing & Sanitary", "Electrical Supplies", "Security & Surveillance",
      "Fuel & Lubricants", "Vehicle Maintenance", "Transport Services", "Utilities & Bills",
      "Seeds & Inputs", "Fertilizers & Chemicals", "Farm Tools & Equipment", "Greenhouse Supplies",
      "Crop Harvesting & Processing", "Agro Consultancy & Training",
      "Animal Feed & Supplements", "Livestock & Poultry", "Veterinary Services",
      "Food & Groceries", "Furniture & Fixtures", "Utensils & Cutlery", "Cleaning Supplies", "Baby & Kids Supplies",
      "Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine",
      "Stationery & Office Supplies", "Professional & Business Services", "Employee Salaries & Wages",
      "Licenses & Permits", "Rent, Lease & Property",
      "Electronics & Appliances", "Phones & Accessories", "Computers & IT Equipment",
      "Raw Materials", "Packaging Supplies", "Gifts & Donations", "Entertainment & Leisure",
      "Repairs & Maintenance", "Emergency Purchases", "Other"
    ];

    if (category && validCategories.includes(category)) {
      return category;
    }

    return "Other";
  } catch (error) {
    console.error("Category suggestion failed:", error);
    return "Other";
  }
}; */
/**
 * Generates a human-readable spending summary from receipt data with prompt caching
 * @param receipts Array of receipt data
 * @returns Promise resolving to formatted summary text
 */
export const generateSummary = async (receipts: ReceiptData[]): Promise<string> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    const error = new Error('Missing Gemini API key - VITE_GEMINI_API_KEY not configured');
    const apiError = handleApiError(error, 'generateSummary');
    throw new Error(getUserMessage(apiError));
  }

  if (!receipts.length) {
    return "No receipt data available to generate summary";
  }

  // Prepare structured data (optimized format to reduce tokens)
  const receiptTexts = receipts.map(r => {
    const items = r.items?.map(i => `${i.name}(${i.quantity}×${i.price})`).join('; ') || '-';
    return `${r.receiptDate}|${r.supplier}|${r.totalAmount}|${r.category || 'Other'}|${items}`;
  }).join('\n');

  // Use prompt caching: static instructions are cached, only dynamic data changes
  const payload = {
    systemInstruction: {
      parts: [{
        text: `You are a financial analyst. Analyze receipt data and generate concise summaries.
Format: Date|Supplier|Total|Category|Items

Always provide:
1. Total Spending (sum)
2. Spending by Category
3. Top 3 Suppliers
4. Key Patterns

Be brief. Use bullet points.`
      }],
      cachedContent: true // Mark as cacheable
    },
    contents: [{
      role: "user",
      parts: [{
        text: `Analyze these receipts:\n${receiptTexts}`
      }]
    }],
    generationConfig: {
      temperature: 0.2, // More deterministic for cost savings
      maxOutputTokens: 300 // Reduced from 500
    }
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        },
        body: JSON.stringify(payload)
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || 'Summary generation failed');
    }

    const result: GeminiResponse = await response.json();

    // Log token usage
    if ((result as any).usageMetadata) {
      const usage = (result as any).usageMetadata;
      logCost(usage.promptTokens || 0, 'input', 'gemini-1.5-flash');
      logCost(usage.cacheReadTokens || 0, 'cached', 'gemini-1.5-flash');
      logCost(usage.outputTokens || 0, 'output', 'gemini-1.5-flash');
    }

    const summary = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return summary || "Could not generate summary from the receipt data";
  } catch (error) {
    const apiError = handleApiError(error, 'generateSummary');
    // Return user-friendly message, detailed error is logged by handleApiError
    return getUserMessage(apiError);
  }
};


