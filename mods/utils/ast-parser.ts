import jsTokens from 'js-tokens';

export interface PlayerActionMethodNames {
  previousButtonMethod: string | null;
  nextButtonMethod: string | null;
  engagementActionsMethod: string | null;
}

const SKIPPED_TOKEN_TYPES = new Set([
  'WhiteSpace',
  'LineTerminatorSequence',
  'SingleLineComment',
  'MultiLineComment',
  'HashbangComment',
]);
const OPEN_BRACKETS = new Set(['(', '{', '[']);
const CLOSE_BRACKETS = new Set([')', '}', ']']);

/**
 * Extracts obfuscated player action method names from `YtlrPlayerActionsContainer` constructor source
 * using the `js-tokens` ECMAScript lexer.
 */
export function extractPlayerActionMethodNames(constructorSource: string): PlayerActionMethodNames {
  const result: PlayerActionMethodNames = {
    previousButtonMethod: null,
    nextButtonMethod: null,
    engagementActionsMethod: null,
  };

  const tokens = Array.from(jsTokens(constructorSource)).filter((token) => !SKIPPED_TOKEN_TYPES.has(token.type));

  for (let i = 0; i + 3 < tokens.length; i++) {
    const t0 = tokens[i];
    const t1 = tokens[i + 1];
    const t2 = tokens[i + 2];
    const t3 = tokens[i + 3];
    if (
      t0?.type !== 'IdentifierName' ||
      t0.value !== 'this' ||
      t1?.type !== 'Punctuator' ||
      t1.value !== '.' ||
      t2?.type !== 'IdentifierName' ||
      t3?.type !== 'Punctuator' ||
      t3.value !== '='
    ) {
      continue;
    }

    const propName = t2.value;
    let depth = 0;
    let hasSkipNext = false;
    let hasSkipPrev = false;
    let hasEngagement = false;

    for (let j = i + 4; j < tokens.length; j++) {
      const tok = tokens[j];
      if (!tok) break;
      if (tok.type === 'Punctuator') {
        if (OPEN_BRACKETS.has(tok.value)) {
          depth++;
        } else if (CLOSE_BRACKETS.has(tok.value)) {
          if (depth === 0) break;
          depth--;
          if (depth === 0 && tok.value === '}') break;
        } else if (depth === 0 && (tok.value === ';' || tok.value === ',')) {
          break;
        }
      } else if (
        tok.type === 'IdentifierName' ||
        tok.type === 'StringLiteral' ||
        tok.type === 'NoSubstitutionTemplate'
      ) {
        if (tok.value.includes('skipNextButton')) hasSkipNext = true;
        if (tok.value.includes('skipPreviousButton')) hasSkipPrev = true;
        if (tok.value.includes('engagementActions')) hasEngagement = true;
      }
    }

    if (!result.previousButtonMethod && hasSkipNext && hasSkipPrev) {
      result.previousButtonMethod = propName;
    } else if (!result.nextButtonMethod && hasSkipPrev && hasSkipNext) {
      result.nextButtonMethod = propName;
    } else if (!result.engagementActionsMethod && hasEngagement) {
      result.engagementActionsMethod = propName;
    }

    if (result.previousButtonMethod && result.nextButtonMethod && result.engagementActionsMethod) {
      break;
    }
  }

  return result;
}
