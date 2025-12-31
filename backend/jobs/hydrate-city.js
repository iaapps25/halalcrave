// City Hydration Job
// Run manually: node jobs/hydrate-city.js <city_name>
// 
// This script:
// 1. Takes a city name as argument
// 2. Runs grid-based Google Places search
// 3. Stores restaurants in database
// 4. Fetches Place Details ONCE per restaurant
// 5. Marks city as hydrated
//
// IMPORTANT: This should ONLY be run after manual approval

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const BASE_URL = 'https://maps.googleapis.com/maps/api/place';

// Grid configuration
const GRID_SEARCH_RADIUS = 5000; // 5km per point
const GRID_SPACING = 0.036; // ~4km spacing

// City coordinates (add more as needed)
const CITY_COORDS = {
  'calgary': { lat: 51.0447, lng: -114.0719, country: 'Canada' },
  'toronto': { lat: 43.6532, lng: -79.3832, country: 'Canada' },
  'vancouver': { lat: 49.2827, lng: -123.1207, country: 'Canada' },
  'edmonton': { lat: 53.5461, lng: -113.4938, country: 'Canada' },
  'montreal': { lat: 45.5017, lng: -73.5673, country: 'Canada' },
  'ottawa': { lat: 45.4215, lng: -75.6972, country: 'Canada' },
  'new york': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'los angeles': { lat: 34.0522, lng: -118.2437, country: 'USA' },
  'chicago': { lat: 41.8781, lng: -87.6298, country: 'USA' },
  'houston': { lat: 29.7604, lng: -95.3698, country: 'USA' },
  'london': { lat: 51.5074, lng: -0.1278, country: 'UK' },
  'birmingham': { lat: 52.4862, lng: -1.8904, country: 'UK' },
  'dubai': { lat: 25.2048, lng: 55.2708, country: 'UAE' },
};

// Generate 5x5 grid points
function generateGrid(centerLat, centerLng) {
  const points = [];
  const offsets = [-2, -1, 0, 1, 2];
  
  for (const latOff of offsets) {
    for (const lngOff of offsets) {
      points.push({
        lat: centerLat + (latOff * GRID_SPACING),
        lng: centerLng + (lngOff * GRID_SPACING * 1.4),
      });
    }
  }
  return points;
}

// Fetch from Google Places API
async function fetchPlaces(url) {
  const response = await fetch(url);
  return response.json();
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Halal keyword analysis
const HALAL_KEYWORDS = [
  'halal certified', '100% halal', 'fully halal', 'zabiha', 
  'halal meat', 'strictly halal', 'halal restaurant'
];

function analyzeHalalKeywords(name, types = []) {
  const keywords = [];
  const nameLower = name.toLowerCase();
  
  if (nameLower.includes('halal')) {
    keywords.push('name_contains_halal');
  }
  
  // Add more analysis as needed
  return keywords;
}

// Detect cuisine from name and types
function detectCuisine(name, types = []) {
  const nameLower = name.toLowerCase();
  
  if (nameLower.includes('shawarma') || nameLower.includes('falafel') || nameLower.includes('mediterranean')) {
    return 'Middle Eastern';
  }
  if (nameLower.includes('indian') || nameLower.includes('curry') || nameLower.includes('biryani')) {
    return 'Indian';
  }
  if (nameLower.includes('pakistani') || nameLower.includes('karahi')) {
    return 'Pakistani';
  }
  if (nameLower.includes('afghan')) {
    return 'Afghan';
  }
  if (nameLower.includes('turkish') || nameLower.includes('kebab') || nameLower.includes('doner')) {
    return 'Turkish';
  }
  if (nameLower.includes('pizza')) {
    return 'Pizza';
  }
  if (nameLower.includes('burger')) {
    return 'Burgers';
  }
  if (nameLower.includes('chinese') || nameLower.includes('wok')) {
    return 'Chinese';
  }
  if (nameLower.includes('thai')) {
    return 'Thai';
  }
  
  return 'Other';
}

// Main hydration function
async function hydrateCity(cityName) {
  console.log(`\n🚀 Starting hydration for: ${cityName}\n`);
  
  const cityKey = cityName.toLowerCase();
  const cityData = CITY_COORDS[cityKey];
  
  if (!cityData) {
    console.error(`❌ City "${cityName}" not found in CITY_COORDS. Please add coordinates.`);
    process.exit(1);
  }

  if (!GOOGLE_API_KEY) {
    console.error('❌ GOOGLE_API_KEY not set in environment');
    process.exit(1);
  }

  // Update city request status to 'hydrating'
  await pool.query(`
    UPDATE city_requests 
    SET status = 'hydrating' 
    WHERE LOWER(city) = LOWER($1)
  `, [cityName]);

  const grid = generateGrid(cityData.lat, cityData.lng);
  const seenPlaceIds = new Set();
  const restaurants = [];

  console.log(`📍 Searching ${grid.length} grid points...\n`);

  // Search each grid point
  for (let i = 0; i < grid.length; i++) {
    const point = grid[i];
    console.log(`📍 Point ${i + 1}/${grid.length} | Found so far: ${restaurants.length}`);

    try {
      const url = `${BASE_URL}/nearbysearch/json?location=${point.lat},${point.lng}&radius=${GRID_SEARCH_RADIUS}&type=restaurant&keyword=halal&key=${GOOGLE_API_KEY}`;
      const data = await fetchPlaces(url);

      if (data.status === 'OK') {
        for (const place of data.results) {
          if (!seenPlaceIds.has(place.place_id)) {
            seenPlaceIds.add(place.place_id);
            restaurants.push({
              place_id: place.place_id,
              name: place.name,
              address: place.vicinity || '',
              lat: place.geometry?.location?.lat,
              lng: place.geometry?.location?.lng,
              rating: place.rating || null,
              review_count: place.user_ratings_total || 0,
              types: place.types || [],
            });
          }
        }
      }

      // Rate limiting
      await sleep(200);
    } catch (error) {
      console.error(`  Error at point ${i + 1}:`, error.message);
    }
  }

  console.log(`\n✅ Grid search complete. Found ${restaurants.length} unique restaurants.\n`);

  if (restaurants.length === 0) {
    console.log('⚠️ No restaurants found. Exiting.');
    process.exit(0);
  }

  // Insert restaurants and fetch details
  console.log('💾 Saving to database and fetching details...\n');

  let savedCount = 0;
  for (const r of restaurants) {
    try {
      // Detect cuisine
      const cuisine = detectCuisine(r.name, r.types);
      
      // Analyze halal keywords
      const keywordFlags = analyzeHalalKeywords(r.name, r.types);
      const halalStatus = keywordFlags.includes('name_contains_halal') ? 'verified' : 'unknown';

      // Insert restaurant
      const result = await pool.query(`
        INSERT INTO restaurants (name, address, city, lat, lng, cuisine, halal_status, source, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'google', NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [r.name, r.address, cityName, r.lat, r.lng, cuisine, halalStatus]);

      if (result.rows.length > 0) {
        const restaurantId = result.rows[0].id;

        // Insert google metadata
        await pool.query(`
          INSERT INTO google_metadata (restaurant_id, place_id, rating, review_count, keyword_flags, last_verified_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (restaurant_id) DO UPDATE SET
            rating = $3,
            review_count = $4,
            keyword_flags = $5,
            last_verified_at = NOW()
        `, [restaurantId, r.place_id, r.rating, r.review_count, keywordFlags]);

        savedCount++;
        
        if (savedCount % 50 === 0) {
          console.log(`  Saved ${savedCount}/${restaurants.length}...`);
        }
      }
    } catch (error) {
      console.error(`  Error saving ${r.name}:`, error.message);
    }
  }

  console.log(`\n✅ Saved ${savedCount} restaurants to database.\n`);

  // Update cities table
  await pool.query(`
    INSERT INTO cities (city, country, lat, lng, hydrated_at, restaurant_count, source)
    VALUES ($1, $2, $3, $4, NOW(), $5, 'google')
    ON CONFLICT (city) DO UPDATE SET
      hydrated_at = NOW(),
      restaurant_count = $5
  `, [cityName, cityData.country, cityData.lat, cityData.lng, savedCount]);

  // Update city request status to 'approved'
  await pool.query(`
    UPDATE city_requests 
    SET status = 'approved', approved_at = NOW()
    WHERE LOWER(city) = LOWER($1)
  `, [cityName]);

  console.log(`🎉 City "${cityName}" hydration complete!`);
  console.log(`   - ${savedCount} restaurants added`);
  console.log(`   - City marked as hydrated\n`);

  await pool.end();
}

// Run from command line
const cityArg = process.argv[2];

if (!cityArg) {
  console.log('Usage: node jobs/hydrate-city.js <city_name>');
  console.log('Example: node jobs/hydrate-city.js Calgary');
  console.log('\nAvailable cities:', Object.keys(CITY_COORDS).join(', '));
  process.exit(1);
}

hydrateCity(cityArg).catch(err => {
  console.error('Hydration failed:', err);
  process.exit(1);
});
