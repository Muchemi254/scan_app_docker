# Scan App API Reference

**Base URL**: `http://localhost:8000/api/v1`

**Authentication**: Firebase ID Token in `Authorization: Bearer <token>` header

**Versioning**: `v1` included in all URLs for future compatibility

## 📋 Endpoint Overview

### Health & Status
- `GET /health` - Health check
- `GET /readiness` - Readiness probe

### Receipt Management
All scoped to authenticated user's data only.

```
POST   /users/{userId}/receipts/extract      Extract from image
POST   /users/{userId}/receipts               Create receipt
GET    /users/{userId}/receipts               List receipts (paginated)
GET    /users/{userId}/receipts/{id}          Get single receipt
PUT    /users/{userId}/receipts/{id}          Update receipt
DELETE /users/{userId}/receipts/{id}          Delete receipt
POST   /users/{userId}/receipts/search        Search receipts
POST   /users/{userId}/receipts/summary       Generate AI summary
```

---

## 🔍 Detailed Endpoint Documentation

### Health Check
```http
GET /health
```

**Description**: Health check for monitoring  
**Auth**: Not required  
**Response** (200):
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

---

### Extract Receipt from Image
```http
POST /users/{userId}/receipts/extract
Content-Type: multipart/form-data
Authorization: Bearer <firebase_token>

file: <binary image data>
```

**Description**:
- Upload receipt image
- Gemini AI extracts structured data
- Returns data without saving (for review first)

**Path Parameters**:
- `userId` (string): User ID from Firebase Auth

**Request**:
- `file` (binary, required): Image file (JPEG, PNG, WEBP, HEIC)

**Response** (200):
```json
{
  "supplier": "Best Store",
  "totalAmount": "1500.50",
  "taxAmount": "225.07",
  "receiptDate": "12/25/2024",
  "category": "Groceries & Provisions",
  "invoiceNumber": "INV-12345",
  "kraPin": "A001234567B",
  "cuInvoice": null,
  "batchTitle": null,
  "items": [
    {
      "name": "Milk 1L",
      "quantity": 2,
      "price": "120.00",
      "tax": "18.00",
      "isZeroRated": false
    }
  ]
}
```

**Errors**:
- `400`: Unsupported file type or invalid image
- `401`: Authentication failed
- `500`: Extraction failed

---

### Create Receipt
```http
POST /users/{userId}/receipts
Content-Type: application/json | multipart/form-data
Authorization: Bearer <firebase_token>

{
  "supplier": "string",
  "totalAmount": "string",
  "taxAmount": "string (optional)",
  "receiptDate": "MM/DD/YYYY",
  "category": "string (optional)",
  "invoiceNumber": "string (optional)",
  "kraPin": "string (optional)",
  "cuInvoice": "string (optional)",
  "batchTitle": "string (optional)",
  "items": [{"name": "...", "quantity": 1, "price": "..."}]
}

// Optional: upload image file
file: <binary image data>
```

**Description**:
- Create new receipt
- Can include image upload
- Usually called after `/extract` endpoint

**Request Fields**:
- `supplier` (string, required): Store/supplier name
- `totalAmount` (string, required): Total with or without currency symbol
- `taxAmount` (string, optional): Tax amount
- `receiptDate` (string, required): Date in MM/DD/YYYY format
- `category` (string, optional): Expense category
- `items` (array, required): List of items purchased
- `file` (binary, optional): Image file for upload

**Response** (201):
```json
{
  "id": "receipt_doc_id",
  "userId": "user_id",
  "supplier": "Best Store",
  "totalAmount": "1500.50",
  "taxAmount": "225.07",
  "receiptDate": "12/25/2024",
  "category": "Groceries & Provisions",
  "items": [...],
  "status": "processed",
  "imageUrl": "https://storage.googleapis.com/...",
  "createdAt": "2024-12-25T10:30:00Z",
  "updatedAt": "2024-12-25T10:30:00Z"
}
```

---

### List Receipts
```http
GET /users/{userId}/receipts?skip=0&limit=50&status=processed&category=Groceries
Authorization: Bearer <firebase_token>
```

**Description**: List user's receipts with pagination and filters

**Query Parameters**:
- `skip` (integer, default: 0): Number to skip
- `limit` (integer, default: 50, max: 100): Number to return
- `status` (string, optional): Filter by `processed` or `needs_review`
- `category` (string, optional): Filter by category

**Response** (200):
```json
{
  "items": [
    {
      "id": "receipt_1",
      "supplier": "Store A",
      "totalAmount": "1500.50",
      "receiptDate": "12/25/2024",
      "status": "processed",
      ...
    }
  ],
  "total": 142,
  "skip": 0,
  "limit": 50
}
```

---

### Get Single Receipt
```http
GET /users/{userId}/receipts/{receiptId}
Authorization: Bearer <firebase_token>
```

**Description**: Get detailed receipt by ID

**Path Parameters**:
- `userId` (string): User ID
- `receiptId` (string): Receipt document ID

**Response** (200):
```json
{
  "id": "receipt_id",
  "userId": "user_id",
  "supplier": "Best Store",
  "totalAmount": "1500.50",
  "taxAmount": "225.07",
  "receiptDate": "12/25/2024",
  "category": "Groceries & Provisions",
  "invoiceNumber": "INV-12345",
  "kraPin": "A001234567B",
  "cuInvoice": null,
  "batchTitle": null,
  "items": [
    {
      "name": "Milk 1L",
      "quantity": 2,
      "price": "120.00",
      "tax": "18.00",
      "isZeroRated": false
    }
  ],
  "status": "processed",
  "imageUrl": "https://storage.googleapis.com/...",
  "createdAt": "2024-12-25T10:30:00Z",
  "updatedAt": "2024-12-25T11:00:00Z"
}
```

**Errors**:
- `404`: Receipt not found
- `403`: Access denied (trying to access another user's data)

---

### Update Receipt
```http
PUT /users/{userId}/receipts/{receiptId}
Content-Type: application/json | multipart/form-data
Authorization: Bearer <firebase_token>

{
  "supplier": "New Store Name",
  "status": "processed",
  ...
}

// Optional: new image
file: <binary image data>
```

**Description**: Update existing receipt (partial update)

**Request Body**: Any subset of receipt fields (all optional):
- `supplier`, `totalAmount`, `taxAmount`, `receiptDate`
- `category`, `status`, `invoiceNumber`, `kraPin`, `cuInvoice`, `batchTitle`
- `items` (replace all items)

**Response** (200): Updated receipt (same as GET single receipt)

**Errors**:
- `404`: Receipt not found
- `403`: Access denied

---

### Delete Receipt
```http
DELETE /users/{userId}/receipts/{receiptId}
Authorization: Bearer <firebase_token>
```

**Description**:
- Delete receipt
- Also deletes associated image from storage

**Response**: 204 No Content

**Errors**:
- `404`: Receipt not found
- `403`: Access denied

---

### Search Receipts
```http
POST /users/{userId}/receipts/search?supplier=Store&category=Groceries&date_from=2024-12-01&date_to=2024-12-31
Authorization: Bearer <firebase_token>
```

**Description**: Advanced search with multiple filters

**Query Parameters**:
- `supplier` (string, optional): Search by supplier name
- `category` (string, optional): Filter by category
- `date_from` (string, optional): Start date (YYYY-MM-DD)
- `date_to` (string, optional): End date (YYYY-MM-DD)

**Response** (200):
```json
[
  {
    "id": "receipt_1",
    "supplier": "Store",
    "totalAmount": "1500.50",
    ...
  }
]
```

---

### Generate Spending Summary
```http
POST /users/{userId}/receipts/summary?status=processed&category=Groceries
Authorization: Bearer <firebase_token>
```

**Description**:
- Generate AI-powered spending analysis
- Uses all receipts (or filtered subset)
- Powered by Gemini API

**Query Parameters**:
- `status` (string, optional): Filter receipts before analysis
- `category` (string, optional): Filter receipts before analysis

**Response** (200):
```json
{
  "summary": "Your spending analysis:\n- Total: KES 15,234.50\n- Top category: Groceries (KES 9,000)\n- Top suppliers: Best Store (KES 5,234), Market A (KES 3,450)\n- Pattern: Consistent grocery purchases",
  "totalSpent": 15234.50,
  "byCategory": {
    "Groceries & Provisions": 9000.00,
    "Transport Services": 3200.00,
    "Restaurants & Catering": 3034.50
  },
  "topSuppliers": [
    ["Best Store", 5234.50],
    ["Market A", 3450.00],
    ["Restaurant B", 3034.50]
  ]
}
```

**Errors**:
- `500`: Summary generation failed

---

## 🔐 Authentication

All endpoints (except `/health`) require Firebase ID token:

### Getting a Token

**From Frontend**:
```javascript
import { getAuth } from 'firebase/auth';

const auth = getAuth();
const token = await auth.currentUser.getIdToken();
```

**Headers**:
```
Authorization: Bearer <token>
```

### Token Validation

Backend validates:
1. Token signature (Firebase public key)
2. Token expiration
3. `uid` claim matches URL `userId`

---

## 📊 Request/Response Examples

### Curl Examples

**Extract receipt**:
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts/extract \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@receipt.jpg"
```

**Create receipt**:
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "supplier": "Store Name",
    "totalAmount": "1000.00",
    "receiptDate": "12/25/2024",
    "items": [{"name": "Item", "quantity": 1, "price": "1000.00"}]
  }'
```

**List receipts**:
```bash
curl http://localhost:8000/api/v1/users/uid123/receipts \
  -H "Authorization: Bearer $TOKEN"
```

**Get single receipt**:
```bash
curl http://localhost:8000/api/v1/users/uid123/receipts/receipt_id \
  -H "Authorization: Bearer $TOKEN"
```

**Update receipt**:
```bash
curl -X PUT http://localhost:8000/api/v1/users/uid123/receipts/receipt_id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "needs_review"}'
```

**Delete receipt**:
```bash
curl -X DELETE http://localhost:8000/api/v1/users/uid123/receipts/receipt_id \
  -H "Authorization: Bearer $TOKEN"
```

**Generate summary**:
```bash
curl -X POST http://localhost:8000/api/v1/users/uid123/receipts/summary \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🧪 Testing with Swagger UI

Interactive API testing available at: **http://localhost:8000/docs**

Features:
- Execute requests directly from browser
- See request/response examples
- View parameter documentation
- Authorize with Firebase token (copy-paste into "Authorize" button)

---

## ⚠️ Error Handling

All errors follow standard HTTP status codes:

| Status | Meaning | Example |
|--------|---------|---------|
| 200 | OK | Successful GET/POST/PUT |
| 201 | Created | Successful POST (new resource) |
| 204 | No Content | Successful DELETE |
| 400 | Bad Request | Invalid file type, malformed JSON |
| 401 | Unauthorized | Missing or invalid token |
| 403 | Forbidden | Accessing another user's data |
| 404 | Not Found | Receipt doesn't exist |
| 422 | Validation Error | Missing required field |
| 500 | Server Error | Firebase/Gemini API failure |

### Error Response Format

```json
{
  "detail": "Human-readable error message"
}
```

Or for validation errors:

```json
{
  "detail": "Validation error",
  "errors": [
    {
      "loc": ["body", "supplier"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ]
}
```

---

## 📝 Data Models

### Receipt

```typescript
interface Receipt {
  id: string;                          // Document ID
  userId: string;                      // Owner's user ID
  supplier: string;                    // Store/supplier name
  totalAmount: string;                 // Total (e.g., "1500.50")
  taxAmount?: string;                  // Tax amount
  receiptDate: string;                 // MM/DD/YYYY format
  category?: string;                   // Expense category
  invoiceNumber?: string;              // Receipt/invoice number
  kraPin?: string;                     // KRA PIN
  cuInvoice?: string;                  // CU invoice number
  batchTitle?: string;                 // Batch/transaction title
  items: ReceiptItem[];                // Purchased items
  status: "processed" | "needs_review"; // Processing status
  imageUrl?: string;                   // Original receipt image URL
  createdAt: ISO8601DateTime;          // Creation timestamp
  updatedAt?: ISO8601DateTime;         // Last update timestamp
}
```

### Receipt Item

```typescript
interface ReceiptItem {
  name: string;                        // Item name
  quantity: number;                    // Quantity purchased
  price: string;                       // Price per unit (e.g., "120.00")
  tax?: string;                        // Tax on item
  isZeroRated?: boolean;               // Zero-rated for VAT?
}
```

### Spending Summary

```typescript
interface SpendingSummary {
  summary: string;                     // AI-generated text analysis
  totalSpent: number;                  // Total amount spent
  byCategory: Record<string, number>;  // Spending per category
  topSuppliers: Array<[string, number]>; // [[name, amount], ...]
}
```

---

## 🔄 Common Workflows

### Workflow 1: Scan Receipt

1. **Extract** `POST /users/{userId}/receipts/extract`
   - Upload image
   - Get structured data (don't save yet)

2. **Review** (Frontend)
   - Show extracted data to user
   - Allow editing

3. **Create** `POST /users/{userId}/receipts`
   - POST reviewed data
   - Or upload new image

### Workflow 2: View Receipts

1. **List** `GET /users/{userId}/receipts`
   - Get first page of receipts
   - Handle pagination with `skip`/`limit`

2. **Filter** (in list or search)
   - By status, category, supplier
   - By date range

3. **Details** `GET /users/{userId}/receipts/{id}`
   - Get full receipt with items

### Workflow 3: Edit Receipt

1. **Get** `GET /users/{userId}/receipts/{id}`
   - Load current data

2. **Update** `PUT /users/{userId}/receipts/{id}`
   - Send changed fields only
   - Can include new image

### Workflow 4: Generate Report

1. **Summary** `POST /users/{userId}/receipts/summary`
   - Query params: `?status=processed&category=Groceries`
   - Returns AI analysis

---

## 🎯 Best Practices

### Performance

1. **Pagination**: Always use `limit` parameter (max 100)
2. **Filtering**: Filter on server, not in frontend
3. **Caching**: Frontend can cache summary results

### Security

1. **Tokens**: Store Firebase token in secure HTTP-only cookies
2. **CORS**: Configure strict origins in production
3. **Secrets**: Never commit `.env` file
4. **HTTPS**: Use in production

### Error Handling

1. **Check status codes**: 401, 403, 404, 422, 500
2. **Display errors**: Show `detail` field to users
3. **Log failures**: Log all errors for debugging
4. **Retry logic**: Retry on 5xx with exponential backoff

---

## 📞 Support

- **API Docs**: http://localhost:8000/docs
- **Health Check**: http://localhost:8000/health
- **Logs**: `docker-compose logs -f backend`
- **Issues**: Check README.md troubleshooting section
