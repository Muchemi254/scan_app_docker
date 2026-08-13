import asyncio
import json
from app.services import batch_service

async def check():
    r = await batch_service.get_redis()
    keys = await r.keys('batch:*')
    if not keys:
        print("No batches found in Redis")
        return
    for k in keys:
        val = await r.get(k)
        data = json.loads(val)
        items_summary = {}
        for item in data['items']:
            status = item.get('status', 'unknown')
            items_summary[status] = items_summary.get(status, 0) + 1
        print(f"Batch: {k}")
        print(f"  Overall Status: {data.get('status')}")
        print(f"  Items Summary: {items_summary}")
        print("-" * 20)

if __name__ == "__main__":
    asyncio.run(check())
