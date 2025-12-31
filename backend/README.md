# HalalCrave Backend

Backend API for the HalalCrave app. Handles restaurant data, city requests, and halal voting.

## Architecture

```
Client (Expo App)
    ↓ (HTTP requests)
Backend (Express + PostgreSQL)
    ↓ (Only during hydration)
Google Places API
```

**Key principle:** Google API is ONLY called during manual city hydration, never from the client.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Setup

Create a PostgreSQL database and run the schema:

```bash
# Create database
createdb halalcrave

# Run migrations
psql halalcrave -f schema.sql
```

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `GOOGLE_API_KEY` - Google Places API key (backend only)
- `PORT` - Server port (default: 3000)

### 4. Run Server

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## API Endpoints

### Restaurants

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/restaurants?city=CityName` | Get restaurants for a city |
| GET | `/api/restaurants/:id` | Get restaurant details |
| POST | `/api/restaurants/submit` | Submit missing restaurant |

### Cities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cities` | Get all hydrated cities |
| GET | `/api/cities/:city/status` | Check if city is available |
| POST | `/api/city-request` | Request a new city |

### Voting

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/votes/:restaurantId` | Get vote counts |
| POST | `/api/votes/:restaurantId` | Cast a vote |

## City Hydration

Cities are hydrated **manually** after approval. Never automatically.

### Process:

1. User requests city via app → `POST /api/city-request`
2. Admin reviews requests → `GET /api/city-requests`
3. Admin approves and runs hydration:

```bash
node jobs/hydrate-city.js Calgary
```

4. Hydration job:
   - Runs 5x5 grid search (25 points)
   - Calls Google Places API (~50 calls)
   - Stores restaurants in database
   - Marks city as hydrated

### Adding New Cities

Edit `jobs/hydrate-city.js` and add coordinates to `CITY_COORDS`:

```javascript
const CITY_COORDS = {
  'new city': { lat: XX.XXXX, lng: -XX.XXXX, country: 'Country' },
  // ...
};
```

## Deployment

### Railway / Render / Heroku

1. Create PostgreSQL database
2. Set environment variables
3. Deploy from GitHub

```bash
# Railway
railway login
railway init
railway up

# Render
# Connect GitHub repo, auto-deploy on push
```

### Manual VPS

```bash
# Install Node.js 18+
# Install PostgreSQL
# Clone repo
git clone <repo>
cd backend

# Install and setup
npm install
cp .env.example .env
# Edit .env with your values

# Run schema
psql $DATABASE_URL -f schema.sql

# Start with PM2
npm install -g pm2
pm2 start server.js --name halalcrave-api
```

## Caching Rules

- Restaurant data is **permanent** (source of truth)
- Google metadata fetched **ONCE** per restaurant
- No automatic refresh
- Manual re-fetch only for:
  - Admin triggers refresh
  - User flags restaurant as outdated
  - Last verified > 12 months

## Legal / Safety

- Raw Google review text is **NOT stored**
- Google Place IDs are **NOT exposed** to client
- Only derived summaries used (keyword flags)
- Google API key lives **ONLY on backend**
