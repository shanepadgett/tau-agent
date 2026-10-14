import type { Plugin } from "@oxlint/plugins";
import {
  noChainedAssertions,
  noWidenThenAssert,
  requireAssertionJustification,
} from "./assertion-rules.ts";
import { noCommentedCode, noInternalReferences, noNarrationComments } from "./comment-rules.ts";
import {
  noUnknownReturns,
  noUnknownTypeAliases,
  noUnsafeDictionaryTypes,
} from "./contract-rules.ts";
import { noSilentErrorSwallow, noYieldlessGen, preferEffectFn } from "./effect-rules.ts";
import { errorNeedsCause } from "./error-rules.ts";
import {
  noArrayFilterMap,
  noConditionalEmptySpread,
  noInOperator,
  noRuntimeTypeof,
} from "./expression-rules.ts";
import { noRestatingJsdoc, requireFileDoc } from "./jsdoc-rules.ts";
import { noGenericFilenames } from "./no-generic-filenames.ts";
import { noModuleLet } from "./no-module-let.ts";
import { noReexportOnlyModules } from "./no-reexport-only-modules.ts";
import { noVagueIdentifiers } from "./naming-rules.ts";
import {
  noBooleanParameters,
  noObjectParameters,
  noOptionalParameters,
  noUnknownParameters,
} from "./parameter-rules.ts";
import { requireReadableSpacing } from "./require-readable-spacing.ts";
import { restrictedApiRules } from "./restricted-api.ts";
import { noManualTaggedConstruction, noTagAccess } from "./tagged-rules.ts";

const plugin: Plugin = {
  meta: { name: "tau" },
  rules: {
    ...restrictedApiRules,
    "error-needs-cause": errorNeedsCause,
    "no-array-filter-map": noArrayFilterMap,
    "no-boolean-parameters": noBooleanParameters,
    "no-chained-assertions": noChainedAssertions,
    "no-commented-code": noCommentedCode,
    "no-conditional-empty-spread": noConditionalEmptySpread,
    "no-generic-filenames": noGenericFilenames,
    "no-in-operator": noInOperator,
    "no-internal-references": noInternalReferences,
    "no-manual-tagged-construction": noManualTaggedConstruction,
    "no-module-let": noModuleLet,
    "no-narration-comments": noNarrationComments,
    "no-object-parameters": noObjectParameters,
    "no-optional-parameters": noOptionalParameters,
    "no-reexport-only-modules": noReexportOnlyModules,
    "no-restating-jsdoc": noRestatingJsdoc,
    "no-runtime-typeof": noRuntimeTypeof,
    "no-silent-error-swallow": noSilentErrorSwallow,
    "no-tag-access": noTagAccess,
    "no-unknown-parameters": noUnknownParameters,
    "no-unknown-returns": noUnknownReturns,
    "no-unknown-type-aliases": noUnknownTypeAliases,
    "no-unsafe-dictionary-types": noUnsafeDictionaryTypes,
    "no-vague-identifiers": noVagueIdentifiers,
    "no-widen-then-assert": noWidenThenAssert,
    "no-yieldless-gen": noYieldlessGen,
    "prefer-effect-fn": preferEffectFn,
    "require-assertion-justification": requireAssertionJustification,
    "require-file-doc": requireFileDoc,
    "require-readable-spacing": requireReadableSpacing,
  },
};

export default plugin;
