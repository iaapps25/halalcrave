-- ============================================
-- RESTAURANT SUBMISSIONS TABLE
-- For user-submitted restaurants
-- ============================================

CREATE TABLE IF NOT EXISTS restaurant_submissions (
  id SERIAL PRIMARY KEY,
  restaurant_name VARCHAR(255) NOT NULL,
  city VARCHAR(100) NOT NULL,
  address TEXT,
  user_notes TEXT,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, rejected
  submitted_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  place_id VARCHAR(255),  -- Filled when approved
  CONSTRAINT submissions_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_submissions_status ON restaurant_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_city ON restaurant_submissions(LOWER(city));
