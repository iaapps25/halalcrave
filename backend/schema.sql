-- HalalCrave Database Schema
-- PostgreSQL

-- ============ TABLES ============

-- Restaurants table - Main source of truth
CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100) NOT NULL,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  cuisine VARCHAR(100),
  halal_status VARCHAR(20) DEFAULT 'unknown' CHECK (halal_status IN ('verified', 'community', 'unknown')),
  halal_confidence_score INTEGER DEFAULT 0,
  source VARCHAR(20) DEFAULT 'google' CHECK (source IN ('google', 'user', 'osm')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Google metadata - Cached Google data (fetched ONCE per restaurant)
CREATE TABLE IF NOT EXISTS google_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  place_id VARCHAR(255) UNIQUE,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  keyword_flags TEXT[], -- Array of halal-related keywords found
  phone VARCHAR(50),
  website TEXT,
  hours TEXT[],
  last_verified_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(restaurant_id)
);

-- City requests - User requests for new cities
CREATE TABLE IF NOT EXISTS city_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city VARCHAR(100) NOT NULL,
  country VARCHAR(100),
  request_count INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hydrating')),
  created_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  UNIQUE(LOWER(city))
);

-- Cities - Hydrated cities with restaurant data
CREATE TABLE IF NOT EXISTS cities (
  city VARCHAR(100) PRIMARY KEY,
  country VARCHAR(100),
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  hydrated_at TIMESTAMP,
  restaurant_count INTEGER DEFAULT 0,
  source VARCHAR(50) DEFAULT 'manual'
);

-- Votes - Community halal voting
CREATE TABLE IF NOT EXISTS votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  vote VARCHAR(3) CHECK (vote IN ('yes', 'no')),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(restaurant_id, user_id)
);

-- ============ INDEXES ============

CREATE INDEX IF NOT EXISTS idx_restaurants_city ON restaurants(LOWER(city));
CREATE INDEX IF NOT EXISTS idx_restaurants_halal_status ON restaurants(halal_status);
CREATE INDEX IF NOT EXISTS idx_restaurants_location ON restaurants(lat, lng);
CREATE INDEX IF NOT EXISTS idx_google_metadata_place_id ON google_metadata(place_id);
CREATE INDEX IF NOT EXISTS idx_google_metadata_restaurant ON google_metadata(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_votes_restaurant ON votes(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_city_requests_status ON city_requests(status);

-- ============ FUNCTIONS ============

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_restaurants_updated_at ON restaurants;
CREATE TRIGGER update_restaurants_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============ INITIAL DATA (Optional) ============

-- Add some initial cities that are approved
INSERT INTO cities (city, country, lat, lng, source)
VALUES 
  ('Calgary', 'Canada', 51.0447, -114.0719, 'manual'),
  ('Toronto', 'Canada', 43.6532, -79.3832, 'manual'),
  ('Vancouver', 'Canada', 49.2827, -123.1207, 'manual')
ON CONFLICT (city) DO NOTHING;

-- ============ ADMIN VIEWS ============

-- View for city request dashboard
CREATE OR REPLACE VIEW city_request_dashboard AS
SELECT 
  cr.city,
  cr.country,
  cr.request_count,
  cr.status,
  cr.created_at,
  c.hydrated_at,
  c.restaurant_count
FROM city_requests cr
LEFT JOIN cities c ON LOWER(cr.city) = LOWER(c.city)
ORDER BY cr.request_count DESC;

-- View for restaurant statistics
CREATE OR REPLACE VIEW restaurant_stats AS
SELECT 
  city,
  COUNT(*) as total_restaurants,
  COUNT(*) FILTER (WHERE halal_status = 'verified') as verified_count,
  COUNT(*) FILTER (WHERE halal_status = 'community') as community_verified_count,
  COUNT(*) FILTER (WHERE halal_status = 'unknown') as unverified_count,
  AVG(halal_confidence_score) as avg_confidence
FROM restaurants
GROUP BY city
ORDER BY total_restaurants DESC;
