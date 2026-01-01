// HalalCrave Backend Server
// Node.js + Express + PostgreSQL

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============ RESTAURANTS ============

// GET /api/restaurants?city=CityName
app.get('/api/restaurants', async (req, res) => {
  try {
    const { city } = req.query;
    
    if (!city) {
      return res.status(400).json({ message: 'City parameter is required' });
    }

    const result = await pool.query(`
      SELECT 
        r.id,
        r.name,
        r.address,
        r.city,
        r.lat,
        r.lng,
        r.cuisine,
        r.halal_status,
        r.halal_confidence_score,
        r.source,
        r.image,
        r.created_at,
        gm.rating,
        gm.review_count,
        gm.phone
      FROM restaurants r
      LEFT JOIN google_metadata gm ON r.id = gm.restaurant_id
      WHERE LOWER(r.city) = LOWER($1)
      ORDER BY gm.rating DESC NULLS LAST, r.name ASC
    `, [city]);

    res.json({ restaurants: result.rows });
  } catch (error) {
    console.error('Error fetching restaurants:', error);
    res.status(500).json({ message: 'Failed to fetch restaurants' });
  }
});

// GET /api/restaurants/:id
app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        r.id,
        r.name,
        r.address,
        r.city,
        r.lat,
        r.lng,
        r.cuisine,
        r.halal_status,
        r.halal_confidence_score,
        r.source,
        r.image,
        r.created_at,
        gm.rating,
        gm.review_count,
        gm.phone,
        gm.website,
        gm.hours
      FROM restaurants r
      LEFT JOIN google_metadata gm ON r.id = gm.restaurant_id
      WHERE r.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Restaurant not found' });
    }

    res.json({ restaurant: result.rows[0] });
  } catch (error) {
    console.error('Error fetching restaurant:', error);
    res.status(500).json({ message: 'Failed to fetch restaurant' });
  }
});

// POST /api/restaurants/submit - Submit missing restaurant for review
app.post('/api/restaurants/submit', async (req, res) => {
  try {
    const { name, address, city, notes } = req.body;

    if (!name || !city) {
      return res.status(400).json({ message: 'Restaurant name and city are required' });
    }

    // Check if already submitted
    const existing = await pool.query(`
      SELECT id, status FROM restaurant_submissions
      WHERE LOWER(restaurant_name) = LOWER($1) AND LOWER(city) = LOWER($2)
    `, [name, city]);

    if (existing.rows.length > 0) {
      const status = existing.rows[0].status;
      if (status === 'approved') {
        return res.json({ success: true, message: 'This restaurant is already in our database!' });
      }
      return res.json({ success: true, message: 'This restaurant has already been submitted and is pending review.' });
    }

    // Insert new submission
    await pool.query(`
      INSERT INTO restaurant_submissions (restaurant_name, city, address, user_notes, status, submitted_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW())
    `, [name, city, address || null, notes || null]);

    res.json({ 
      success: true, 
      message: 'Thank you! Your submission has been received and will be reviewed soon.'
    });
  } catch (error) {
    console.error('Error submitting restaurant:', error);
    res.status(500).json({ message: 'Failed to submit restaurant' });
  }
});

// GET /api/submissions - Get all pending submissions (admin)
app.get('/api/submissions', async (req, res) => {
  try {
    const { status } = req.query;
    
    let query = 'SELECT * FROM restaurant_submissions';
    let params = [];
    
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    
    query += ' ORDER BY submitted_at DESC';
    
    const result = await pool.query(query, params);
    res.json({ submissions: result.rows });
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ message: 'Failed to fetch submissions' });
  }
});

// GET /api/submissions/count - Get pending count
app.get('/api/submissions/count', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM restaurant_submissions WHERE status = 'pending'
    `);
    res.json({ pending_count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Error fetching submission count:', error);
    res.status(500).json({ message: 'Failed to fetch count' });
  }
});

// ============ CITIES ============

// GET /api/cities - Get all available (hydrated) cities
app.get('/api/cities', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        city,
        hydrated_at,
        restaurant_count,
        source
      FROM cities
      WHERE hydrated_at IS NOT NULL
      ORDER BY restaurant_count DESC
    `);

    res.json({ cities: result.rows });
  } catch (error) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ message: 'Failed to fetch cities' });
  }
});

// GET /api/cities/:city/status
app.get('/api/cities/:city/status', async (req, res) => {
  try {
    const { city } = req.params;

    const result = await pool.query(`
      SELECT 
        city,
        hydrated_at,
        restaurant_count
      FROM cities
      WHERE LOWER(city) = LOWER($1)
    `, [city]);

    if (result.rows.length === 0) {
      return res.json({ exists: false, hydrated: false });
    }

    const cityData = result.rows[0];
    res.json({ 
      exists: true, 
      hydrated: cityData.hydrated_at !== null,
      restaurant_count: cityData.restaurant_count || 0
    });
  } catch (error) {
    console.error('Error checking city status:', error);
    res.status(500).json({ message: 'Failed to check city status' });
  }
});

// ============ CITY REQUESTS ============

// POST /api/city-request
app.post('/api/city-request', async (req, res) => {
  try {
    const { city, country } = req.body;

    if (!city) {
      return res.status(400).json({ message: 'City is required' });
    }

    // Check if request already exists
    const existing = await pool.query(`
      SELECT id, request_count FROM city_requests
      WHERE LOWER(city) = LOWER($1)
    `, [city]);

    if (existing.rows.length > 0) {
      // Increment request count
      await pool.query(`
        UPDATE city_requests
        SET request_count = request_count + 1
        WHERE id = $1
      `, [existing.rows[0].id]);

      return res.json({ 
        success: true, 
        message: 'Request count incremented',
        request_count: existing.rows[0].request_count + 1
      });
    }

    // Create new request
    const result = await pool.query(`
      INSERT INTO city_requests (city, country, request_count, status, created_at)
      VALUES ($1, $2, 1, 'pending', NOW())
      RETURNING id, request_count
    `, [city, country || '']);

    res.json({ 
      success: true, 
      message: 'City request submitted',
      request_count: 1
    });
  } catch (error) {
    console.error('Error submitting city request:', error);
    res.status(500).json({ message: 'Failed to submit city request' });
  }
});

// GET /api/city-requests - Admin endpoint to view all requests
app.get('/api/city-requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM city_requests
      ORDER BY request_count DESC, created_at DESC
    `);

    res.json({ requests: result.rows });
  } catch (error) {
    console.error('Error fetching city requests:', error);
    res.status(500).json({ message: 'Failed to fetch city requests' });
  }
});

// ============ VOTING ============

// GET /api/votes/:restaurantId
app.get('/api/votes/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.headers['x-user-id'] || 'anonymous';

    // Get vote counts
    const counts = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE vote = 'yes') as yes_count,
        COUNT(*) FILTER (WHERE vote = 'no') as no_count
      FROM votes
      WHERE restaurant_id = $1
    `, [restaurantId]);

    // Get user's vote
    const userVote = await pool.query(`
      SELECT vote FROM votes
      WHERE restaurant_id = $1 AND user_id = $2
    `, [restaurantId, userId]);

    res.json({
      yesCount: parseInt(counts.rows[0].yes_count) || 0,
      noCount: parseInt(counts.rows[0].no_count) || 0,
      userVote: userVote.rows[0]?.vote || null
    });
  } catch (error) {
    console.error('Error fetching votes:', error);
    res.status(500).json({ message: 'Failed to fetch votes' });
  }
});

// POST /api/votes/:restaurantId
app.post('/api/votes/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { vote } = req.body;
    const userId = req.headers['x-user-id'] || 'anonymous';

    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ message: 'Vote must be "yes" or "no"' });
    }

    // Upsert vote
    await pool.query(`
      INSERT INTO votes (restaurant_id, user_id, vote, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (restaurant_id, user_id)
      DO UPDATE SET vote = $3, created_at = NOW()
    `, [restaurantId, userId, vote]);

    // Get updated counts
    const counts = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE vote = 'yes') as yes_count,
        COUNT(*) FILTER (WHERE vote = 'no') as no_count
      FROM votes
      WHERE restaurant_id = $1
    `, [restaurantId]);

    // Update halal confidence score on restaurant
    const yesCount = parseInt(counts.rows[0].yes_count) || 0;
    const noCount = parseInt(counts.rows[0].no_count) || 0;
    const total = yesCount + noCount;
    const confidenceScore = total > 0 ? Math.round((yesCount / total) * 100) : 0;

    if (total >= 5) {
      // Update halal status based on votes
      const status = confidenceScore >= 70 ? 'community' : 'unknown';
      await pool.query(`
        UPDATE restaurants
        SET halal_status = $1, halal_confidence_score = $2
        WHERE id = $3
      `, [status, confidenceScore, restaurantId]);
    }

    res.json({
      yesCount,
      noCount,
      userVote: vote
    });
  } catch (error) {
    console.error('Error casting vote:', error);
    res.status(500).json({ message: 'Failed to cast vote' });
  }
});

// ============ HEALTH CHECK ============

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ START SERVER ============

app.listen(PORT, () => {
  console.log(`HalalCrave API running on port ${PORT}`);
});

module.exports = app;

