-- ============================================
-- FIX: Update halal_status constraint
-- Run this BEFORE re-running hydration
-- ============================================

-- Remove old constraint (if exists)
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_halal_status_check;

-- Add new constraint that includes 'unverified'
ALTER TABLE restaurants ADD CONSTRAINT restaurants_halal_status_check 
CHECK (halal_status IN ('verified', 'unverified', 'community', 'unknown'));

-- Verify the constraint
SELECT conname, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conname = 'restaurants_halal_status_check';
