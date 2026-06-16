-- Re-add the column (nullable). Data cannot be restored — pre-images were
-- never recoverable once dropped; new rows would carry NULL as before.
ALTER TABLE audit_writes ADD COLUMN pre_image TEXT;
