-- Idempotency helper procedures for znapi migrations.
-- Re-runnable: each DROPs then CREATEs (so 0000_ is exempt from checksum tracking).
-- VERIFIED against MySQL 9.4: all procedures load cleanly; SIGNAL-based asserts raise
-- ERROR 1644 on failure and are clean no-ops on success.
--
-- ADD NEW HELPERS HERE as migrations need them — growing this file is safe because the
-- runner re-applies 0000_ on every run (Task 10 discovery exemption).

-- ── Structural guards ────────────────────────────────────────────────────────────────

DROP PROCEDURE IF EXISTS zn_add_index_if_missing;
DELIMITER //
CREATE PROCEDURE zn_add_index_if_missing(IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
  SQL SECURITY INVOKER
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = tbl AND index_name = idx) THEN
    SET @s = CONCAT('CREATE INDEX ', idx, ' ON ', tbl, ' (', cols, ')');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

-- MySQL 8 refuses a CHECK clause that references a column participating in a FOREIGN KEY with a
-- referential action (ON UPDATE / ON DELETE CASCADE or SET NULL):
--   ERROR 3823: Column 'company_id' cannot be used in a check constraint 'chk_x': needed in a
--   foreign key constraint 'fk_y' referential action.
-- Because every PK here derives from CompanyPK, this hits `company_id` on most tenant tables. The
-- same clause IS accepted when the FK has no referential action, so a hand-built fixture without
-- the real FK will green-light a migration that production rejects. When an invariant genuinely
-- needs such a column, keep the column-local part in the CHECK and enforce the cross-column part
-- with BEFORE INSERT / BEFORE UPDATE triggers that SIGNAL SQLSTATE '45000' (surfacing as
-- ERROR 1644), and assert them through information_schema.triggers: zn_assert_check_contains
-- reads information_schema.check_constraints and cannot see a trigger body.
DROP PROCEDURE IF EXISTS zn_replace_check;
DELIMITER //
CREATE PROCEDURE zn_replace_check(IN tbl VARCHAR(64), IN cname VARCHAR(64), IN clause TEXT)
  SQL SECURITY INVOKER
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_schema = DATABASE() AND table_name = tbl AND constraint_name = cname) THEN
    SET @d = CONCAT('ALTER TABLE ', tbl, ' DROP CHECK ', cname);
    PREPARE st FROM @d; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
  SET @a = CONCAT('ALTER TABLE ', tbl, ' ADD CONSTRAINT ', cname, ' CHECK (', clause, ')');
  PREPARE st FROM @a; EXECUTE st; DEALLOCATE PREPARE st;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_add_column_if_missing;
DELIMITER //
CREATE PROCEDURE zn_add_column_if_missing(IN tbl VARCHAR(64), IN col VARCHAR(64), IN coldef TEXT)
  SQL SECURITY INVOKER
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', col, ' ', coldef);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_drop_column_if_exists;
DELIMITER //
CREATE PROCEDURE zn_drop_column_if_exists(IN tbl VARCHAR(64), IN col VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = tbl AND column_name = col) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' DROP COLUMN ', col);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_add_unique_if_missing;
DELIMITER //
CREATE PROCEDURE zn_add_unique_if_missing(IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols VARCHAR(255))
  SQL SECURITY INVOKER
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND table_name = tbl AND index_name = idx) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD CONSTRAINT ', idx, ' UNIQUE (', cols, ')');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

-- ── Postcondition assertions ─────────────────────────────────────────────────────────
-- These RAISE (SIGNAL SQLSTATE '45000' → ERROR 1644) when the asserted end-state is
-- absent. JDBC execute() surfaces that as a SQLException, so the run ABORTS and the
-- row stays success=0. VERIFIED against MySQL 9.4: a passing assert is a clean no-op;
-- a failing one stops the script. MESSAGE_TEXT MUST be a variable (a CONCAT expression
-- there is a syntax error). Every migration ends with one or more CALL zn_assert_*.

DROP PROCEDURE IF EXISTS zn_assert_column;
DELIMITER //
CREATE PROCEDURE zn_assert_column(IN tbl VARCHAR(64), IN col VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema=DATABASE() AND table_name=tbl AND column_name=col) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: ', tbl, '.', col, ' missing');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_column_absent;
DELIMITER //
CREATE PROCEDURE zn_assert_column_absent(IN tbl VARCHAR(64), IN col VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema=DATABASE() AND table_name=tbl AND column_name=col) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: ', tbl, '.', col, ' still present');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_table;
DELIMITER //
CREATE PROCEDURE zn_assert_table(IN tbl VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema=DATABASE() AND table_name=tbl) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: table ', tbl, ' missing');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_true;
DELIMITER //
CREATE PROCEDURE zn_assert_true(IN predicate_sql TEXT, IN assertion_label VARCHAR(128))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  SET @zn_assert_ok = NULL;
  SET @s = CONCAT('SELECT IF((', predicate_sql, '), 1, 0) INTO @zn_assert_ok');
  PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  IF COALESCE(@zn_assert_ok, 0) <> 1 THEN
    SET msg = CONCAT('POSTCONDITION FAILED: ', assertion_label);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_index;
DELIMITER //
CREATE PROCEDURE zn_assert_index(IN tbl VARCHAR(64), IN idx VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                 WHERE table_schema=DATABASE() AND table_name=tbl AND index_name=idx) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: index ', tbl, '.', idx, ' missing');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_check_contains;
DELIMITER //
CREATE PROCEDURE zn_assert_check_contains(IN cname VARCHAR(64), IN needle VARCHAR(255))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                 WHERE constraint_schema=DATABASE() AND constraint_name=cname
                   AND check_clause LIKE CONCAT('%', needle, '%')) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: check ', cname, ' missing or lacks ', needle);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_drop_fk_if_exists;
DELIMITER //
CREATE PROCEDURE zn_drop_fk_if_exists(IN tbl VARCHAR(64), IN fk VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_schema = DATABASE() AND table_name = tbl
               AND constraint_name = fk AND constraint_type = 'FOREIGN KEY') THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' DROP FOREIGN KEY ', fk);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_fk_absent;
DELIMITER //
CREATE PROCEDURE zn_assert_fk_absent(IN tbl VARCHAR(64), IN fk VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_schema = DATABASE() AND table_name = tbl
               AND constraint_name = fk AND constraint_type = 'FOREIGN KEY') THEN
    SET msg = CONCAT('POSTCONDITION FAILED: FK ', tbl, '.', fk, ' still present');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_no_null_column;
DELIMITER //
CREATE PROCEDURE zn_assert_no_null_column(IN tbl VARCHAR(64), IN col VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  SET @s = CONCAT('SELECT COUNT(*) INTO @zn_assert_cnt FROM ', tbl, ' WHERE ', col, ' IS NULL');
  PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  IF @zn_assert_cnt > 0 THEN
    SET msg = CONCAT('POSTCONDITION FAILED: ', @zn_assert_cnt, ' ', tbl, ' row(s) still have ', col, ' IS NULL');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_pk;
DELIMITER //
CREATE PROCEDURE zn_assert_pk(IN tbl VARCHAR(64))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = tbl
                   AND constraint_type = 'PRIMARY KEY') THEN
    SET msg = CONCAT('POSTCONDITION FAILED: table ', tbl, ' has no PRIMARY KEY');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;

DROP PROCEDURE IF EXISTS zn_assert_fk_present;
DELIMITER //
CREATE PROCEDURE zn_assert_fk_present(IN tbl VARCHAR(64), IN fk VARCHAR(64), IN del_rule VARCHAR(16))
  SQL SECURITY INVOKER
BEGIN
  DECLARE msg VARCHAR(255);
  IF NOT EXISTS (SELECT 1 FROM information_schema.referential_constraints
                 WHERE constraint_schema = DATABASE() AND table_name = tbl
                   AND constraint_name = fk AND delete_rule = del_rule) THEN
    SET msg = CONCAT('POSTCONDITION FAILED: FK ', tbl, '.', fk, ' missing or not ON DELETE ', del_rule);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = msg;
  END IF;
END //
DELIMITER ;
