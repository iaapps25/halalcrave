/**
 * HYDRATION CHECK - See what's in your database
 * 
 * Shows:
 * - How many restaurants per city
 * - How many places we've seen (won't re-fetch)
 * - Estimated cost for next hydration
 * 
 * Usage: node jobs/hydrate-check.js [city_name]
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function checkStats(cityFilter = null) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 HYDRATION DATABASE STATUS');
  console.log(`${'═'.repeat(60)}\n`);
  
  // Restaurant counts by city
  console.log('🍽️  RESTAURANTS BY CITY:\n');
  
  const restaurants = await pool.query(`
    SELECT 
      city,
      COUNT(*) as total,
      SUM(CASE WHEN halal_status = 'verified' THEN 1 ELSE 0 END) as verified,
      SUM(CASE WHEN halal_status = 'unverified' THEN 1 ELSE 0 END) as unverified,
      SUM(CASE WHEN halal_status = 'community' THEN 1 ELSE 0 END) as community,
      SUM(CASE WHEN discovered_via = 'explicit' THEN 1 ELSE 0 END) as from_search,
      SUM(CASE WHEN discovered_via = 'review' THEN 1 ELSE 0 END) as from_review
    FROM restaurants
    ${cityFilter ? "WHERE LOWER(city) = LOWER($1)" : ""}
    GROUP BY city
    ORDER BY total DESC
  `, cityFilter ? [cityFilter] : []);
  
  if (restaurants.rows.length === 0) {
    console.log('   No restaurants in database yet.\n');
  } else {
    console.log('   City            | Total | Verified | Unverified | Community');
    console.log('   ' + '─'.repeat(55));
    
    for (const row of restaurants.rows) {
      const city = row.city.padEnd(15);
      const total = String(row.total).padStart(5);
      const verified = String(row.verified).padStart(8);
      const unverified = String(row.unverified).padStart(10);
      const community = String(row.community).padStart(9);
      console.log(`   ${city} | ${total} | ${verified} | ${unverified} | ${community}`);
    }
    console.log();
  }
  
  // Seen places (won't re-fetch)
  console.log('👁️  SEEN PLACES (will skip on next run):\n');
  
  const seen = await pool.query(`
    SELECT 
      city,
      COUNT(*) as total_seen,
      SUM(CASE WHEN is_halal THEN 1 ELSE 0 END) as halal,
      SUM(CASE WHEN NOT is_halal THEN 1 ELSE 0 END) as not_halal
    FROM seen_places
    ${cityFilter ? "WHERE LOWER(city) = LOWER($1)" : ""}
    GROUP BY city
    ORDER BY total_seen DESC
  `, cityFilter ? [cityFilter] : []);
  
  if (seen.rows.length === 0) {
    console.log('   No places tracked yet (first run will check everything).\n');
  } else {
    console.log('   City            | Total Seen | Halal | Not Halal');
    console.log('   ' + '─'.repeat(50));
    
    for (const row of seen.rows) {
      const city = row.city.padEnd(15);
      const total = String(row.total_seen).padStart(10);
      const halal = String(row.halal).padStart(5);
      const notHalal = String(row.not_halal).padStart(9);
      console.log(`   ${city} | ${total} | ${halal} | ${notHalal}`);
    }
    console.log();
  }
  
  // Cost estimate
  console.log('💰 ESTIMATED COST FOR NEXT RUN:\n');
  
  const seenCount = seen.rows.reduce((sum, row) => sum + parseInt(row.total_seen), 0);
  const estimatedSearches = 35; // Approximate number of queries
  const estimatedNewPlaces = cityFilter ? 50 : 200; // Estimate for new places
  
  if (seenCount === 0) {
    console.log('   First run (no places seen yet):');
    console.log(`   - Text Searches: ~${estimatedSearches * 3} calls × $0.032 = ~$${(estimatedSearches * 3 * 0.032).toFixed(2)}`);
    console.log(`   - Place Details: ~500-800 calls × $0.017 = ~$8.50-$13.60`);
    console.log(`   - TOTAL: ~$12-17 per city\n`);
  } else {
    console.log('   Incremental run (many places already seen):');
    console.log(`   - Text Searches: ~${estimatedSearches * 2} calls × $0.032 = ~$${(estimatedSearches * 2 * 0.032).toFixed(2)}`);
    console.log(`   - Place Details: ~${estimatedNewPlaces} new × $0.017 = ~$${(estimatedNewPlaces * 0.017).toFixed(2)}`);
    console.log(`   - TOTAL: ~$3-5 per city\n`);
  }
  
  console.log(`${'═'.repeat(60)}\n`);
  
  await pool.end();
}

const city = process.argv[2];
checkStats(city);
