/**
 * APPROVE RESTAURANT SUBMISSION
 * 
 * Fetches details from Google Places and adds to database
 * 
 * Usage: 
 *   node jobs/approve-submission.js list          - List pending submissions
 *   node jobs/approve-submission.js approve <id>  - Approve a submission
 *   node jobs/approve-submission.js reject <id>   - Reject a submission
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Search for restaurant on Google Places
async function searchRestaurant(name, city) {
  const query = `${name} in ${city}`;
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=restaurant&key=${GOOGLE_API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Search error:', error);
    return [];
  }
}

// Get place details
async function getPlaceDetails(placeId) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=place_id,name,formatted_address,geometry,rating,user_ratings_total,photos,formatted_phone_number,website,opening_hours&key=${GOOGLE_API_KEY}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data.result || null;
  } catch (error) {
    console.error('Details error:', error);
    return null;
  }
}

// Detect cuisine from name
function detectCuisine(name) {
  const n = name.toLowerCase();
  if (n.includes('pakistani') || n.includes('karahi')) return 'Pakistani';
  if (n.includes('indian') || n.includes('biryani')) return 'Indian';
  if (n.includes('korean')) return 'Korean';
  if (n.includes('chinese')) return 'Chinese';
  if (n.includes('turkish') || n.includes('kebab')) return 'Turkish';
  if (n.includes('lebanese') || n.includes('shawarma')) return 'Lebanese';
  if (n.includes('afghan')) return 'Afghan';
  if (n.includes('chicken') || n.includes('wing')) return 'Fried Chicken';
  if (n.includes('burger')) return 'Burgers';
  if (n.includes('pizza')) return 'Pizza';
  return 'Restaurant';
}

// Get photo URL
function getPhotoUrl(photos) {
  if (!photos || photos.length === 0) return null;
  return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${photos[0].photo_reference}&key=${GOOGLE_API_KEY}`;
}

// List pending submissions
async function listSubmissions() {
  const result = await pool.query(`
    SELECT * FROM restaurant_submissions 
    WHERE status = 'pending'
    ORDER BY submitted_at DESC
  `);
  
  console.log('\n📋 PENDING SUBMISSIONS\n');
  
  if (result.rows.length === 0) {
    console.log('   No pending submissions!\n');
    return;
  }
  
  console.log('   ID | Restaurant                     | City           | Submitted');
  console.log('   ' + '─'.repeat(70));
  
  for (const row of result.rows) {
    const date = new Date(row.submitted_at).toLocaleDateString();
    console.log(`   ${String(row.id).padEnd(3)}| ${row.restaurant_name.padEnd(31)}| ${row.city.padEnd(15)}| ${date}`);
    if (row.user_notes) {
      console.log(`      Notes: ${row.user_notes}`);
    }
  }
  
  console.log('\nTo approve: node jobs/approve-submission.js approve <id>');
  console.log('To reject:  node jobs/approve-submission.js reject <id>\n');
}

// Approve a submission
async function approveSubmission(id) {
  // Get submission
  const submission = await pool.query(
    'SELECT * FROM restaurant_submissions WHERE id = $1',
    [id]
  );
  
  if (submission.rows.length === 0) {
    console.error(`❌ Submission #${id} not found`);
    return;
  }
  
  const sub = submission.rows[0];
  console.log(`\n🔍 Searching for: "${sub.restaurant_name}" in ${sub.city}...`);
  
  // Search Google Places
  const results = await searchRestaurant(sub.restaurant_name, sub.city);
  
  if (results.length === 0) {
    console.error('❌ No results found on Google Places');
    console.log('   You can manually add this restaurant or reject the submission.');
    return;
  }
  
  // Show results for user to pick
  console.log(`\n📍 Found ${results.length} result(s):\n`);
  
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i];
    console.log(`   [${i + 1}] ${r.name}`);
    console.log(`       ${r.formatted_address || r.vicinity}`);
    console.log(`       Rating: ${r.rating || 'N/A'} (${r.user_ratings_total || 0} reviews)`);
    console.log();
  }
  
  // Use first result (you could make this interactive)
  const selected = results[0];
  console.log(`✅ Using first result: ${selected.name}`);
  
  // Get full details
  const details = await getPlaceDetails(selected.place_id);
  if (!details) {
    console.error('❌ Failed to get place details');
    return;
  }
  
  // Save to restaurants table
  const photoUrl = getPhotoUrl(details.photos);
  const cuisine = detectCuisine(details.name);
  
  try {
    const result = await pool.query(
      `INSERT INTO restaurants (name, address, city, lat, lng, cuisine, halal_status, halal_confidence_score, source, image, discovered_via)
       VALUES ($1, $2, $3, $4, $5, $6, 'verified', 85, 'google', $7, 'user-submission')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        details.name,
        details.formatted_address,
        sub.city,
        details.geometry.location.lat,
        details.geometry.location.lng,
        cuisine,
        photoUrl
      ]
    );
    
    if (result.rows.length > 0) {
      // Add metadata
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
      
      // Mark as seen
      await pool.query(
        `INSERT INTO seen_places (place_id, city, name, is_halal, checked_at)
         VALUES ($1, $2, $3, true, NOW())
         ON CONFLICT (place_id) DO NOTHING`,
        [details.place_id, sub.city, details.name]
      );
      
      // Update submission status
      await pool.query(
        `UPDATE restaurant_submissions 
         SET status = 'approved', reviewed_at = NOW(), place_id = $1
         WHERE id = $2`,
        [details.place_id, id]
      );
      
      console.log(`\n🎉 SUCCESS! "${details.name}" has been added to the database.`);
      console.log(`   Restaurant ID: ${result.rows[0].id}`);
    } else {
      console.log('\n⚠️  Restaurant already exists in database (no duplicate added)');
      
      // Still mark submission as approved
      await pool.query(
        `UPDATE restaurant_submissions SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
        [id]
      );
    }
  } catch (error) {
    console.error('❌ Error saving restaurant:', error.message);
  }
}

// Reject a submission
async function rejectSubmission(id) {
  await pool.query(
    `UPDATE restaurant_submissions SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`,
    [id]
  );
  console.log(`\n❌ Submission #${id} has been rejected.\n`);
}

// Main
async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];
  
  if (!command || command === 'list') {
    await listSubmissions();
  } else if (command === 'approve' && arg) {
    await approveSubmission(parseInt(arg));
  } else if (command === 'reject' && arg) {
    await rejectSubmission(parseInt(arg));
  } else {
    console.log('\nUsage:');
    console.log('  node jobs/approve-submission.js list          - List pending submissions');
    console.log('  node jobs/approve-submission.js approve <id>  - Approve a submission');
    console.log('  node jobs/approve-submission.js reject <id>   - Reject a submission\n');
  }
  
  await pool.end();
}

main();
