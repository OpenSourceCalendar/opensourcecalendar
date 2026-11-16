-- Consent belongs to the booking and the number that was typed for it, not to whoever
-- the customer record says owns that email.
ALTER TABLE consents ADD COLUMN phone TEXT;
-- Which booking's manage link asked for deletion, so the owner can judge the request.
ALTER TABLE customers ADD COLUMN delete_request_appointment_id TEXT;
