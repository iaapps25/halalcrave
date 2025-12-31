# City Hydration Guide

## Overview

This system finds halal restaurants in a city using Google Places API, while:
- **Minimizing costs** (only fetches new places)
- **Finding hidden halal** (checks reviews for places like "Seoul Fried Chicken")
- **Being repeatable** (run monthly without re-fetching old data)

---

## How It Works

```
┌─────────────────────────────────────────┐
│  PHASE 1: EXPLICIT HALAL                │
│  Search: "halal restaurant", etc.       │
│  → Saved as VERIFIED                    │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  PHASE 2: CATEGORY SEARCH               │
│  Search: "fried chicken", "burger"      │
│  → Check reviews for "halal"            │
│  → If found: Saved as UNVERIFIED        │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│  DATABASE                               │
│  • restaurants: halal places            │
│  • seen_places: ALL checked place_ids   │
└─────────────────────────────────────────┘
```

---

## Setup (First Time Only)

### 1. Run Schema Update

In **Supabase SQL Editor**, run the contents of `schema-update.sql`:

```sql
-- Creates seen_places table
-- Adds image and discovered_via columns to restaurants
```

### 2. Clear Old Data (if re-hydrating)

```sql
-- Only if you want to start fresh
DELETE FROM google_metadata WHERE restaurant_id IN (SELECT id FROM restaurants WHERE city = 'Calgary');
DELETE FROM restaurants WHERE city = 'Calgary';
DELETE FROM seen_places WHERE city = 'Calgary';
```

---

## Running Hydration

### Check Current Status

```bash
node jobs/hydrate-check.js
# or for specific city:
node jobs/hydrate-check.js Calgary
```

### Hydrate a City

```bash
node jobs/hydrate.js Calgary
```

This will:
1. Search for explicit halal restaurants → save as **VERIFIED**
2. Search category terms (fried chicken, etc.)
3. For each NEW place, fetch details + reviews
4. If reviews mention "halal" → save as **UNVERIFIED**
5. Track ALL place_ids in `seen_places` (won't re-fetch)

---

## Cost Breakdown

### First Run (New City)
| Step | API Calls | Cost |
|------|-----------|------|
| Text Searches (~35 queries × 2 pages) | ~70 | ~$2.24 |
| Place Details (check ~600 places) | ~600 | ~$10.20 |
| **TOTAL** | | **~$12-15** |

### Monthly Update (Same City)
| Step | API Calls | Cost |
|------|-----------|------|
| Text Searches (same queries) | ~70 | ~$2.24 |
| Place Details (only NEW places) | ~50 | ~$0.85 |
| **TOTAL** | | **~$3-4** |

---

## Halal Status Meanings

| Status | Meaning | How Found |
|--------|---------|-----------|
| `verified` | Definitely halal | Name/search contains "halal" |
| `unverified` | Likely halal | Reviews mention "halal" |
| `community` | Community confirmed | 5+ users voted halal |
| `unknown` | Unknown | Default for user submissions |

---

## User Experience

In the app:
- **VERIFIED** → Green badge "✅ Verified Halal"
- **UNVERIFIED** → Yellow badge "⚠️ Call to verify"
- **COMMUNITY** → Blue badge "👥 Community Verified"

---

## Files

| File | Purpose |
|------|---------|
| `jobs/hydrate.js` | Main hydration script |
| `jobs/hydrate-check.js` | Check database stats |
| `schema-update.sql` | Database schema updates |

---

## Adding New Cities

Edit `CITY_COORDS` in `jobs/hydrate.js`:

```javascript
const CITY_COORDS = {
  'new city': { lat: XX.XXXX, lng: -XX.XXXX, country: 'Country' },
};
```

Then run:
```bash
node jobs/hydrate.js "new city"
```

---

## Quarterly Update Schedule

1. **January, April, July, October**: Run hydration for all cities
2. Each run only fetches NEW places
3. Cost: ~$3-5 per city after first run

```bash
# Update all cities
node jobs/hydrate.js Calgary
node jobs/hydrate.js Toronto
node jobs/hydrate.js Vancouver
# etc.
```
