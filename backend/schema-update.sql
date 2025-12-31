-- ============================================
-- SCHEMA UPDATE: Incremental Hydration Support
-- ============================================

-- 1. Track ALL places we've ever checked (halal or not)
CREATE TABLE IF NOT EXISTS seen_places (
  place_id VARCHAR(255) PRIMARY KEY,
  city VARCHAR(100) NOT NULL,
  name VARCHAR(255),
  is_halal BOOLEAN DEFAULT FALSE,
  checked_at TIMESTAMP DEFAULT NOW()
);

-- 2. Add new columns to restaurants table
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS image TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS discovered_via VARCHAR(50) DEFAULT 'explicit';
-- discovered_via: 'explicit' (halal search), 'review' (found in reviews), 'user' (user submitted)

-- 3. Update halal_status to use new values
-- 'verified' = explicitly halal (name/search)
-- 'unverified' = halal mentioned in reviews (needs confirmation)
-- 'community' = community voted
-- 'unknown' = unknown

-- 4. Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_seen_places_city ON seen_places(LOWER(city));
CREATE INDEX IF NOT EXISTS idx_restaurants_discovered ON restaurants(discovered_via);

-- 5. View to see hydration stats
CREATE OR REPLACE VIEW hydration_stats AS
SELECT 
  city,
  COUNT(*) as total_seen,
  SUM(CASE WHEN is_halal THEN 1 ELSE 0 END) as halal_count,
  SUM(CASE WHEN NOT is_halal THEN 1 ELSE 0 END) as non_halal_count,
  MAX(checked_at) as last_checked
FROM seen_places
GROUP BY city;
