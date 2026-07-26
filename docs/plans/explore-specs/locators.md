# Locators

## Goal

- Give agents short numeric handles to declarations/scopes/matches discovered by structural tools.
- Let later tools (`symbol`, relationships, locator edits) resolve those handles safely.
- Fail closed when identity is unknown or stale.

## Issuing locators

- Structural outputs that refer to retrievable declarations/scopes/matches include parenthesized numeric IDs.
- Only rows intended to be retrievable get locators (structural package/import/side-effect rows may render without locators).
- Multiple public aliases that share one native declaration identity still get distinct numeric IDs for agent convenience, but resolve to the same underlying declaration token for retrieval.

## Validity

- A locator is valid only if:
  - it was issued in the current locator generation/session table
  - it has not been marked stale
  - the AST worker generation has not restarted since issue (worker restart invalidates)
- Unknown locator → hard error telling agent to run outline/api_discover (or relevant issuer) again.
- Stale locator → hard error telling agent to re-issue.

## Staleness

- Any successful mutation that changes a file marks all locators bound to that file path stale.
- External Tau file-mutation events for changed/moved paths also invalidate locators for those paths.
- Session clear / tree reset clears the locator table.

## Batch atomicity (`symbol`)

- `symbol` resolves the whole requested locator set first.
- If any locator is unknown/stale, the entire batch fails and no partial declaration payload is returned.

## Overflow and locator retention

- When multi-unit structural output is truncated for the model but complete overflow is saved:
  - locators for units still visible to the model remain valid
  - locators only present in non-visible overflow units are dropped so agents cannot hold IDs they never saw
- If overflow persistence fails / is incomplete, retention follows the same “only what the model saw” rule.

## Fresh locators after edits

- Locator edits that successfully apply and reparse may register fresh locators for verified post-edit declarations.
- Edit results report invalidated old IDs and fresh IDs.
- Fresh IDs are usable immediately for `symbol` / further edits if verification succeeded.

## Markdown locators

- Markdown heading locators identify the heading and its complete section range (through deeper subsections until the next same-or-higher heading).
- Section semantics are part of symbol retrieval and locator edit rules.
