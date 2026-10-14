/** Adds saved check-report text to existing entries without changing what their model context says. */

// These are the characters String.trim removes, including non-ASCII spaces.
const TRIM_CHARACTERS =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const CHECK_REPORT_TEXT_MIGRATION =
  "WITH reports AS (SELECT rowid, CASE WHEN body ->> '$.type' = 'checks' " +
  "THEN '$.report' ELSE '$.details.report' END AS location, CASE WHEN body ->> '$.type' = 'checks' " +
  "THEN body -> '$.report' ELSE body -> '$.details.report' END AS report FROM entry " +
  "WHERE body ->> '$.type' = 'checks' OR body ->> '$.details.tool' = 'checks'), " +
  "rendered AS (SELECT rowid, location, (SELECT coalesce(group_concat(piece, char(10) || char(10)), '') " +
  "FROM (SELECT 0 AS part, key, 'Passed: ' || value AS piece FROM json_each(reports.report, '$.passed') " +
  "UNION ALL SELECT 1 AS part, key, 'Failed: ' || (value ->> '$.name') || char(10) || " +
  `trim(value ->> '$.output', '${TRIM_CHARACTERS}') AS piece FROM json_each(reports.report, '$.failed') ` +
  "ORDER BY part, key)) AS text FROM reports) " +
  "UPDATE entry SET body = json_set(body, rendered.location || '.text', rendered.text) " +
  "FROM rendered WHERE entry.rowid = rendered.rowid";
