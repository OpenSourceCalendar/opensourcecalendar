-- Each appointment keeps the contact details submitted for it, so public replies never show
-- the stored customer record. delete_requested_at flags a customer's delete-my-data request.
ALTER TABLE appointments ADD COLUMN contact_first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN contact_last_name TEXT NOT NULL DEFAULT '';
ALTER TABLE appointments ADD COLUMN contact_phone TEXT;
ALTER TABLE appointments ADD COLUMN contact_email TEXT;
ALTER TABLE customers ADD COLUMN delete_requested_at INTEGER;
