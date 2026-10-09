-- Online public-origin cutover: immutable ownership stays guarded throughout.
-- Fresh/partial DDL requires the managed local root actor; a lease without definer
-- privileges must fail while creating the bridge, before dropping the original.
-- A completed failed attempt reconciles through the exact stable postconditions.
CALL zn_assert_true('(SELECT COUNT(*) FROM _mwm_part_b_integration WHERE api_base_url=''https://partners-sandbox.zincapp.com/api'' AND (runtime_id<>''partner-sandbox'' OR target_tenant_id<>99007))=0','Legacy sandbox URL belongs only to the assigned runtime');
CALL zn_assert_true('(SELECT COUNT(*) FROM _mwm_part_b_integration WHERE runtime_id=''partner-sandbox'' AND target_tenant_id=99007 AND api_base_url NOT IN (''https://partners-sandbox.zincapp.com/api'',''https://sandbox.zincapp.com''))=0','Assigned sandbox transport must use an approved origin');

DELIMITER $$
CREATE DEFINER='root'@'localhost' TRIGGER IF NOT EXISTS zn_mwm_remote_owner_update_cutover BEFORE UPDATE ON _mwm_part_b_integration FOR EACH ROW
BEGIN
    IF NOT (OLD.binding_id <=> NEW.binding_id) OR NOT (OLD.group_id <=> NEW.group_id)
       OR OLD.partner_id<>NEW.partner_id OR OLD.account_id<>NEW.account_id
       OR OLD.runtime_id<>NEW.runtime_id OR OLD.target_tenant_id<>NEW.target_tenant_id
       OR (OLD.api_base_url<>NEW.api_base_url AND NOT (OLD.runtime_id='partner-sandbox'
           AND OLD.target_tenant_id=99007 AND OLD.api_base_url='https://partners-sandbox.zincapp.com/api'
           AND NEW.api_base_url='https://sandbox.zincapp.com'))
       OR OLD.created_by<>NEW.created_by OR OLD.created_at<>NEW.created_at THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PARTNER_SANDBOX_OWNER_IMMUTABLE';
    END IF;
END$$
DELIMITER ;
CALL zn_assert_true('(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=''zn_mwm_remote_owner_update_cutover'' AND event_object_table=''_mwm_part_b_integration'' AND event_manipulation=''UPDATE'' AND action_timing=''BEFORE'' AND definer=''root@localhost'' AND SHA2(action_statement,256)=''d5300bf7aa47d51a03242ab28cee331175c00c9328764df0182fdad28c2975cf'')=1','Stable cutover ownership guard verified');

DROP TRIGGER IF EXISTS zn_mwm_remote_owner_update;
UPDATE _mwm_part_b_integration
SET api_base_url='https://sandbox.zincapp.com', row_version=row_version+1, updated_at=UTC_TIMESTAMP(6)
WHERE runtime_id='partner-sandbox' AND target_tenant_id=99007
  AND api_base_url='https://partners-sandbox.zincapp.com/api';

DELIMITER $$
CREATE DEFINER='root'@'localhost' TRIGGER zn_mwm_remote_owner_update BEFORE UPDATE ON _mwm_part_b_integration FOR EACH ROW
BEGIN
    IF NOT (OLD.binding_id <=> NEW.binding_id) OR NOT (OLD.group_id <=> NEW.group_id)
       OR OLD.partner_id<>NEW.partner_id OR OLD.account_id<>NEW.account_id
       OR OLD.runtime_id<>NEW.runtime_id OR OLD.target_tenant_id<>NEW.target_tenant_id
       OR OLD.api_base_url<>NEW.api_base_url OR OLD.created_by<>NEW.created_by OR OLD.created_at<>NEW.created_at THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PARTNER_SANDBOX_OWNER_IMMUTABLE';
    END IF;
END$$
DELIMITER ;
CALL zn_assert_true('(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=''zn_mwm_remote_owner_update'' AND event_object_table=''_mwm_part_b_integration'' AND event_manipulation=''UPDATE'' AND action_timing=''BEFORE'' AND definer=''root@localhost'' AND SHA2(action_statement,256)=''6fcbfc3c012cb854eeb311a6ff9779de1af0d5c92719f4bd73e4147634b63ccf'')=1','Stable immutable ownership guard verified');
DROP TRIGGER IF EXISTS zn_mwm_remote_owner_update_cutover;

-- @reconcile-postconditions
CALL zn_assert_true('(SELECT COUNT(*) FROM _mwm_part_b_integration WHERE api_base_url=''https://partners-sandbox.zincapp.com/api'' AND (runtime_id<>''partner-sandbox'' OR target_tenant_id<>99007))=0','Legacy sandbox URL belongs only to the assigned runtime');
CALL zn_assert_true('(SELECT COUNT(*) FROM _mwm_part_b_integration WHERE runtime_id=''partner-sandbox'' AND target_tenant_id=99007 AND api_base_url NOT IN (''https://partners-sandbox.zincapp.com/api'',''https://sandbox.zincapp.com''))=0','Assigned sandbox transport must use an approved origin');
CALL zn_assert_true('(SELECT COUNT(*) FROM _mwm_part_b_integration WHERE runtime_id=''partner-sandbox'' AND target_tenant_id=99007 AND api_base_url<>''https://sandbox.zincapp.com'')=0','Assigned sandbox public origin migrated');
CALL zn_assert_true('(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=''zn_mwm_remote_owner_update'' AND event_object_table=''_mwm_part_b_integration'' AND event_manipulation=''UPDATE'' AND action_timing=''BEFORE'' AND definer=''root@localhost'' AND SHA2(action_statement,256)=''6fcbfc3c012cb854eeb311a6ff9779de1af0d5c92719f4bd73e4147634b63ccf'')=1','Stable immutable ownership guard restored');
CALL zn_assert_true('(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name=''zn_mwm_remote_owner_update_cutover'')=0','Temporary cutover guard removed');
