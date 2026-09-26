-- Settings is a generic key-value store. verify_status there is not effective
-- verification and must not be shown. Rows and known object paths are removed;
-- any deeper leftover is stripped when settings are read.

DELETE FROM settings WHERE key = 'verify_status';

UPDATE settings
SET value_json = json_remove(
  value_json,
  '$.verify_status',
  '$.llm.verify_status',
  '$.library.verify_status',
  '$.radio.verify_status',
  '$.acquisition.verify_status',
  '$.config.verify_status',
  '$.config.llm.verify_status',
  '$.config.library.verify_status',
  '$.config.radio.verify_status',
  '$.config.acquisition.verify_status'
)
WHERE json_valid(value_json)
  AND (
    json_type(value_json, '$.verify_status') IS NOT NULL
    OR json_type(value_json, '$.llm.verify_status') IS NOT NULL
    OR json_type(value_json, '$.library.verify_status') IS NOT NULL
    OR json_type(value_json, '$.radio.verify_status') IS NOT NULL
    OR json_type(value_json, '$.acquisition.verify_status') IS NOT NULL
    OR json_type(value_json, '$.config.verify_status') IS NOT NULL
    OR json_type(value_json, '$.config.llm.verify_status') IS NOT NULL
    OR json_type(value_json, '$.config.library.verify_status') IS NOT NULL
    OR json_type(value_json, '$.config.radio.verify_status') IS NOT NULL
    OR json_type(value_json, '$.config.acquisition.verify_status') IS NOT NULL
  );
