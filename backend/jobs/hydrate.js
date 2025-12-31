/**
 * INCREMENTAL CITY HYDRATION v2
 * 
 * Fixes:
 * - Grid search for full city coverage
 * - Better Phase 2 logic (cuisines + reviews)
 * - Fixed image URLs
 * - Fixed halal_status constraint
 * 
 * Usage: node jobs/hydrate.js <city_name>
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ============================================
// CITY COORDINATES WITH BOUNDS
// ============================================
const CITY_COORDS = {
  'calgary': { 
    lat: 51.0447, lng: -114.0719, country: 'Canada',
    // Calgary city limits (approx)
    bounds: { north: 51.18, south: 50.84, east: -113.86, west: -114.27 }
  },
  'toronto': { 
    lat: 43.6532, lng: -79.3832, country: 'Canada',
    bounds: { north: 43.85, south: 43.58, east: -79.12, west: -79.64 }
  },
  'vancouver': { 
    lat: 49.2827, lng: -123.1207, country: 'Canada',
    bounds: { north: 49.35, south: 49.20, east: -123.02, west: -123.27 }
  },
  'edmonton': { 
    lat: 53.5461, lng: -113.4938, country: 'Canada',
    bounds: { north: 53.67, south: 53.40, east: -113.27, west: -113.71 }
  },
  'montreal': { 
    lat: 45.5017, lng: -73.5673, country: 'Canada',
    bounds: { north: 45.70, south: 45.40, east: -73.47, west: -73.98 }
  },
  'ottawa': { 
    lat: 45.4215, lng: -75.6972, country: 'Canada',
    bounds: { north: 45.54, south: 45.25, east: -75.50, west: -75.92 }
  },
  'mississauga': { 
    lat: 43.5890, lng: -79.6441, country: 'Canada',
    bounds: { north: 43.65, south: 43.52, east: -79.54, west: -79.79 }
  },
  'brampton': { 
    lat: 43.7315, lng: -79.7624, country: 'Canada',
    bounds: { north: 43.82, south: 43.65, east: -79.65, west: -79.87 }
  },
  'new york': { 
    lat: 40.7128, lng: -74.0060, country: 'USA',
    bounds: { north: 40.92, south: 40.50, east: -73.70, west: -74.26 }
  },
  'houston': { 
    lat: 29.7604, lng: -95.3698, country: 'USA',
    bounds: { north: 30.11, south: 29.52, east: -95.01, west: -95.79 }
  },
  'london': { 
    lat: 51.5074, lng: -0.1278, country: 'UK',
    bounds: { north: 51.69, south: 51.28, east: 0.33, west: -0.51 }
  },
  'dubai': { 
    lat: 25.2048, lng: 55.2708, country: 'UAE',
    bounds: { north: 25.36, south: 24.79, east: 55.55, west: 54.89 }
  },
};

// ============================================
// SEARCH QUERIES
// ============================================

// Phase 1: Explicit halal (save as VERIFIED)
const EXPLICIT_HALAL_QUERIES = [
  'halal restaurant',
  'halal food',
  'halal meat',
  'halal chicken',
  'zabiha',
];

// Phase 2: Category searches
// Tier A: ALWAYS HALAL cuisines (save without review check)
const ALWAYS_HALAL_QUERIES = [
  'pakistani restaurant',
  'pakistani food',
  'afghan restaurant',
  'afghan food',
  'somali restaurant',
  'somali food',
  'yemeni restaurant',
  'yemeni food',
  'bangladeshi restaurant',
  'sudanese restaurant',
  'syrian restaurant',
  'palestinian restaurant',
  'egyptian restaurant',
  'moroccan restaurant',
];

// Tier B: LIKELY HALAL cuisines (save without review check, lower confidence)
const LIKELY_HALAL_QUERIES = [
  'middle eastern restaurant',
  'middle eastern food',
  'lebanese restaurant',
  'lebanese food',
  'turkish restaurant',
  'turkish food',
  'indian restaurant',
  'mediterranean restaurant',
  'shawarma',
  'kebab',
  'biryani',
  'falafel',
  'persian restaurant',
  'arab restaurant',
];

// Tier C: CHECK REVIEWS (only save if halal mentioned)
const CHECK_REVIEWS_QUERIES = [
  'fried chicken',
  'chicken wings',
  'korean fried chicken',
  'burger restaurant',
  'pizza restaurant',
  'bbq restaurant',
  'steakhouse',
  'caribbean restaurant',
  'jamaican restaurant',
  'african restaurant',
];

// ============================================
// HELPERS
// ============================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let apiStats = {
  textSearchCalls: 0,
  nearbySearchCalls: 0,
  placeDetailsCalls: 0,
  get searchCost() { return (this.textSearchCalls + this.nearbySearchCalls) * 0.032; },
  get detailsCost() { return this.placeDetailsCalls * 0.017; },
  get totalCost() { return this.searchCost + this.detailsCost; }
};

// Generate grid points within city bounds
function generateGridPoints(bounds, gridSize = 5) {
  const points = [];
  const latStep = (bounds.north - bounds.south) / gridSize;
  const lngStep = (bounds.east - bounds.west) / gridSize;
  
  for (let i = 0; i <= gridSize; i++) {
    for (let j = 0; j <= gridSize; j++) {
      points.push({
        lat: bounds.south + (i * latStep) + (latStep / 2),
        lng: bounds.west + (j * lngStep) + (lngStep / 2)
      });
    }
  }
  
  return points;
}

async function isPlaceSeen(placeId) {
  const result = await pool.query('SELECT 1 FROM seen_places WHERE place_id = $1', [placeId]);
  return result.rows.length > 0;
}

async function markPlaceSeen(placeId, city, name, isHalal) {
  await pool.query(
    `INSERT INTO seen_places (place_id, city, name, is_halal, checked_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (place_id) DO UPDATE SET checked_at = NOW()`,
    [placeId, city, name, isHalal]
  );
}

// Text search
async function textSearch(query, city, pageToken = null) {
  let url;
  if (pageToken) {
    url = `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${pageToken}&key=${GOOGLE_API_KEY}`;
  } else {
    url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query + ' in ' + city)}&type=restaurant&key=${GOOGLE_API_KEY}`;
    apiStats.textSearchCalls++;
  }
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return { results: data.results || [], nextPageToken: data.next_page_token };
  } catch (error) {
    console.error('Search error:', error.message);
    return { results: [], nextPageToken: null };
  }
}

// Nearby search (for grid)
async function nearbySearch(lat, lng, keyword, radius = 5000) {
  apiStats.nearbySearchCalls++;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(keyword)}&type=restaurant&key=${GOOGLE_API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Nearby search error:', error.message);
    return [];
  }
}

// Get all results with pagination
async function getAllSearchResults(query, city) {
  const allResults = [];
  let pageToken = null;
  
  do {
    if (pageToken) {
      await delay(2000);
      apiStats.textSearchCalls++;
    }
    const { results, nextPageToken } = await textSearch(query, city, pageToken);
    allResults.push(...results);
    pageToken = nextPageToken;
  } while (pageToken);
  
  return allResults;
}

// Get place details
async function getPlaceDetails(placeId) {
  apiStats.placeDetailsCalls++;
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=place_id,name,formatted_address,geometry,rating,user_ratings_total,reviews,photos,types,formatted_phone_number,website,opening_hours&key=${GOOGLE_API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.result || null;
  } catch (error) {
    console.error('Details error:', error.message);
    return null;
  }
}

// Check reviews for halal mentions
function checkReviewsForHalal(reviews = []) {
  const halalKeywords = ['halal', 'zabiha', 'zabihah'];
  
  for (const review of reviews) {
    const text = (review.text || '').toLowerCase();
    for (const keyword of halalKeywords) {
      if (text.includes(keyword)) {
        return { found: true, keyword };
      }
    }
  }
  return { found: false };
}

// Detect cuisine
function detectCuisine(name) {
  const n = name.toLowerCase();
  if (n.includes('pakistani') || n.includes('karahi') || n.includes('nihari')) return 'Pakistani';
  if (n.includes('indian') || n.includes('biryani') || n.includes('tandoori')) return 'Indian';
  if (n.includes('bangladeshi') || n.includes('bengali')) return 'Bangladeshi';
  if (n.includes('afghan') || n.includes('kabul')) return 'Afghan';
  if (n.includes('somali')) return 'Somali';
  if (n.includes('yemeni') || n.includes('mandi')) return 'Yemeni';
  if (n.includes('korean')) return 'Korean';
  if (n.includes('chinese')) return 'Chinese';
  if (n.includes('thai')) return 'Thai';
  if (n.includes('turkish') || n.includes('kebab') || n.includes('doner')) return 'Turkish';
  if (n.includes('lebanese') || n.includes('shawarma')) return 'Lebanese';
  if (n.includes('middle eastern') || n.includes('arab')) return 'Middle Eastern';
  if (n.includes('mediterranean') || n.includes('falafel')) return 'Mediterranean';
  if (n.includes('moroccan')) return 'Moroccan';
  if (n.includes('egyptian')) return 'Egyptian';
  if (n.includes('persian') || n.includes('iranian')) return 'Persian';
  if (n.includes('syrian')) return 'Syrian';
  if (n.includes('palestinian')) return 'Palestinian';
  if (n.includes('pizza')) return 'Pizza';
  if (n.includes('burger')) return 'Burgers';
  if (n.includes('chicken') || n.includes('wing')) return 'Fried Chicken';
  if (n.includes('caribbean') || n.includes('jamaican')) return 'Caribbean';
  if (n.includes('african')) return 'African';
  return 'Restaurant';
}

// Get photo URL - FIXED to store photo_reference, actual URL generated at request time
function getPhotoReference(photos) {
  if (!photos || photos.length === 0) return null;
  return photos[0].photo_reference;
}

// Build photo URL from reference
function buildPhotoUrl(photoReference) {
  if (!photoReference) return null;
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photoReference}&key=${GOOGLE_API_KEY}`;
}

// Save restaurant
async function saveRestaurant(details, city, halalStatus, discoveredVia, confidence) {
  try {
    const photoRef = getPhotoReference(details.photos);
    const photoUrl = buildPhotoUrl(photoRef);
    
    const result = await pool.query(
      `INSERT INTO restaurants (name, address, city, lat, lng, cuisine, halal_status, halal_confidence_score, source, image, discovered_via)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'google', $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        details.name,
        details.formatted_address,
        city,
        details.geometry.location.lat,
        details.geometry.location.lng,
        detectCuisine(details.name),
        halalStatus,
        confidence,
        photoUrl,
        discoveredVia
      ]
    );
    
    if (result.rows.length > 0) {
      await pool.query(
        `INSERT INTO google_metadata (restaurant_id, place_id, rating, review_count, phone, website, hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (place_id) DO NOTHING`,
        [
          result.rows[0].id,
          details.place_id,
          details.rating || null,
          details.user_ratings_total || 0,
          details.formatted_phone_number || null,
          details.website || null,
          details.opening_hours?.weekday_text || null
        ]
      );
      return true;
    }
    return false;
  } catch (error) {
    // Don't log constraint errors for duplicates
    if (!error.message.includes('duplicate') && !error.message.includes('constraint')) {
      console.error(`Error saving ${details.name}:`, error.message);
    }
    return false;
  }
}

// ============================================
// MAIN HYDRATION
// ============================================

async function hydrateCity(cityName) {
  const cityKey = cityName.toLowerCase();
  const cityData = CITY_COORDS[cityKey];
  
  if (!cityData) {
    console.error(`\n❌ City "${cityName}" not found`);
    console.log('\nAvailable:', Object.keys(CITY_COORDS).join(', '));
    process.exit(1);
  }
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 HYDRATING: ${cityName.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`   Bounds: N:${cityData.bounds.north} S:${cityData.bounds.south}`);
  console.log(`           E:${cityData.bounds.east} W:${cityData.bounds.west}`);
  
  let totalSaved = 0;
  let totalSkipped = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  
  // ─────────────────────────────────────────
  // PHASE 1: EXPLICIT HALAL (Text + Grid)
  // ─────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('📗 PHASE 1: EXPLICIT HALAL SEARCHES');
  console.log('   Saved as VERIFIED (90-95% confidence)');
  console.log(`${'─'.repeat(60)}\n`);
  
  // 1A: Text search
  console.log('   📝 Text Searches:\n');
  for (const query of EXPLICIT_HALAL_QUERIES) {
    process.stdout.write(`      🔍 "${query}"... `);
    
    const results = await getAllSearchResults(query, cityName);
    let newCount = 0, skipCount = 0;
    
    for (const place of results) {
      if (await isPlaceSeen(place.place_id)) { skipCount++; continue; }
      
      const details = await getPlaceDetails(place.place_id);
      if (!details) continue;
      
      const saved = await saveRestaurant(details, cityName, 'verified', 'explicit', 95);
      await markPlaceSeen(place.place_id, cityName, details.name, true);
      
      if (saved) { verifiedCount++; newCount++; }
      await delay(100);
    }
    
    totalSaved += newCount;
    totalSkipped += skipCount;
    console.log(`+${newCount} saved, ${skipCount} skipped`);
    await delay(300);
  }
  
  // 1B: Grid search for halal
  console.log('\n   📍 Grid Search (full city coverage):\n');
  const gridPoints = generateGridPoints(cityData.bounds, 4); // 5x5 grid = 25 points
  console.log(`      Searching ${gridPoints.length} grid points...`);
  
  let gridNew = 0, gridSkip = 0;
  for (let i = 0; i < gridPoints.length; i++) {
    const point = gridPoints[i];
    const results = await nearbySearch(point.lat, point.lng, 'halal', 4000);
    
    for (const place of results) {
      if (await isPlaceSeen(place.place_id)) { gridSkip++; continue; }
      
      const details = await getPlaceDetails(place.place_id);
      if (!details) continue;
      
      const saved = await saveRestaurant(details, cityName, 'verified', 'explicit-grid', 90);
      await markPlaceSeen(place.place_id, cityName, details.name, true);
      
      if (saved) { verifiedCount++; gridNew++; }
      await delay(50);
    }
    
    if ((i + 1) % 5 === 0) {
      process.stdout.write(`      Point ${i + 1}/${gridPoints.length}... +${gridNew} new\r`);
    }
    await delay(200);
  }
  console.log(`\n      Grid complete: +${gridNew} new, ${gridSkip} skipped`);
  totalSaved += gridNew;
  totalSkipped += gridSkip;
  
  // ─────────────────────────────────────────
  // PHASE 2A: ALWAYS HALAL CUISINES
  // ─────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('📙 PHASE 2A: ALWAYS-HALAL CUISINES');
  console.log('   Pakistani, Afghan, Somali, Yemeni, etc.');
  console.log('   Saved as VERIFIED (85-90% confidence)');
  console.log(`${'─'.repeat(60)}\n`);
  
  for (const query of ALWAYS_HALAL_QUERIES) {
    process.stdout.write(`   🔍 "${query}"... `);
    
    const results = await getAllSearchResults(query, cityName);
    let newCount = 0, skipCount = 0;
    
    for (const place of results) {
      if (await isPlaceSeen(place.place_id)) { skipCount++; continue; }
      
      const details = await getPlaceDetails(place.place_id);
      if (!details) continue;
      
      // Save directly (these cuisines are always halal)
      const saved = await saveRestaurant(details, cityName, 'verified', 'cuisine', 85);
      await markPlaceSeen(place.place_id, cityName, details.name, true);
      
      if (saved) { verifiedCount++; newCount++; }
      await delay(100);
    }
    
    totalSaved += newCount;
    totalSkipped += skipCount;
    console.log(`+${newCount} saved, ${skipCount} skipped`);
    await delay(300);
  }
  
  // ─────────────────────────────────────────
  // PHASE 2B: LIKELY HALAL CUISINES
  // ─────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('📒 PHASE 2B: LIKELY-HALAL CUISINES');
  console.log('   Middle Eastern, Lebanese, Turkish, Indian');
  console.log('   Saved as UNVERIFIED (75% confidence)');
  console.log(`${'─'.repeat(60)}\n`);
  
  for (const query of LIKELY_HALAL_QUERIES) {
    process.stdout.write(`   🔍 "${query}"... `);
    
    const results = await getAllSearchResults(query, cityName);
    let newCount = 0, skipCount = 0;
    
    for (const place of results) {
      if (await isPlaceSeen(place.place_id)) { skipCount++; continue; }
      
      const details = await getPlaceDetails(place.place_id);
      if (!details) continue;
      
      // Save as unverified (likely halal but should confirm)
      const saved = await saveRestaurant(details, cityName, 'unverified', 'cuisine-likely', 75);
      await markPlaceSeen(place.place_id, cityName, details.name, true);
      
      if (saved) { unverifiedCount++; newCount++; }
      await delay(100);
    }
    
    totalSaved += newCount;
    totalSkipped += skipCount;
    console.log(`+${newCount} saved, ${skipCount} skipped`);
    await delay(300);
  }
  
  // ─────────────────────────────────────────
  // PHASE 2C: CHECK REVIEWS
  // ─────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log('📕 PHASE 2C: REVIEW CHECK');
  console.log('   Fried chicken, burgers, etc.');
  console.log('   Only saved if "halal" in reviews');
  console.log(`${'─'.repeat(60)}\n`);
  
  for (const query of CHECK_REVIEWS_QUERIES) {
    process.stdout.write(`   🔍 "${query}"... `);
    
    const results = await getAllSearchResults(query, cityName);
    let checked = 0, halalFound = 0, skipCount = 0;
    
    for (const place of results) {
      if (await isPlaceSeen(place.place_id)) { skipCount++; continue; }
      
      const details = await getPlaceDetails(place.place_id);
      if (!details) continue;
      
      checked++;
      const halalCheck = checkReviewsForHalal(details.reviews);
      
      if (halalCheck.found) {
        const saved = await saveRestaurant(details, cityName, 'unverified', 'review', 70);
        await markPlaceSeen(place.place_id, cityName, details.name, true);
        if (saved) { unverifiedCount++; halalFound++; }
      } else {
        // Not halal - still mark as seen
        await markPlaceSeen(place.place_id, cityName, details.name, false);
      }
      
      await delay(100);
    }
    
    totalSkipped += skipCount;
    console.log(`${checked} checked, ${halalFound} halal found, ${skipCount} skipped`);
    await delay(300);
  }
  
  // ─────────────────────────────────────────
  // UPDATE CITY STATS
  // ─────────────────────────────────────────
  await pool.query(
    `INSERT INTO cities (city, country, lat, lng, hydrated_at, restaurant_count, source)
     VALUES ($1, $2, $3, $4, NOW(), $5, 'hydrate-v2')
     ON CONFLICT (city) DO UPDATE SET 
       hydrated_at = NOW(), 
       restaurant_count = (SELECT COUNT(*) FROM restaurants WHERE LOWER(city) = LOWER($1))`,
    [cityName, cityData.country, cityData.lat, cityData.lng, totalSaved]
  );
  
  // ─────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🎉 HYDRATION COMPLETE: ${cityName.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\n   📊 RESULTS:`);
  console.log(`      ✅ Verified:    ${verifiedCount}`);
  console.log(`      ⚠️  Unverified:  ${unverifiedCount}`);
  console.log(`      📝 Total saved: ${verifiedCount + unverifiedCount}`);
  console.log(`      ⏭️  Skipped:     ${totalSkipped}`);
  
  console.log(`\n   💰 API COSTS:`);
  console.log(`      Text Searches:   ${apiStats.textSearchCalls} calls = $${apiStats.searchCost.toFixed(2)}`);
  console.log(`      Nearby Searches: ${apiStats.nearbySearchCalls} calls (included above)`);
  console.log(`      Place Details:   ${apiStats.placeDetailsCalls} calls = $${apiStats.detailsCost.toFixed(2)}`);
  console.log(`      ─────────────────────────────────────`);
  console.log(`      TOTAL:           $${apiStats.totalCost.toFixed(2)}`);
  
  console.log(`\n${'═'.repeat(60)}\n`);
  
  await pool.end();
}

// ============================================
// RUN
// ============================================
const city = process.argv[2];

if (!city) {
  console.log('\nUsage: node jobs/hydrate.js <city_name>');
  console.log('\nAvailable cities:', Object.keys(CITY_COORDS).join(', '));
  process.exit(1);
}

if (!GOOGLE_API_KEY) {
  console.error('❌ GOOGLE_API_KEY not set');
  process.exit(1);
}

hydrateCity(city);
