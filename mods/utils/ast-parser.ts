export interface PlayerActionMethodNames {
  previousButtonMethod: string | null;
  nextButtonMethod: string | null;
  engagementActionsMethod: string | null;
}

const THIS_ASSIGN_RE = /\bthis\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;

function extractAssignmentBody(source: string, startIndex: number): string {
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: string | null = null;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depthParen++;
    } else if (ch === ')') {
      if (depthParen > 0) depthParen--;
    } else if (ch === '{') {
      depthBrace++;
    } else if (ch === '}') {
      if (depthBrace > 0) {
        depthBrace--;
        if (depthBrace === 0 && depthParen === 0 && depthBracket === 0) {
          return source.slice(startIndex, i + 1);
        }
      } else {
        return source.slice(startIndex, i);
      }
    } else if (ch === '[') {
      depthBracket++;
    } else if (ch === ']') {
      if (depthBracket > 0) depthBracket--;
    } else if ((ch === ';' || ch === ',') && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      return source.slice(startIndex, i);
    }
  }

  return source.slice(startIndex);
}

/**
 * Extracts obfuscated player action method names from `YtlrPlayerActionsContainer` constructor source.
 */
export function extractPlayerActionMethodNames(constructorSource: string): PlayerActionMethodNames {
  const result: PlayerActionMethodNames = {
    previousButtonMethod: null,
    nextButtonMethod: null,
    engagementActionsMethod: null,
  };

  THIS_ASSIGN_RE.lastIndex = 0;
  for (let match = THIS_ASSIGN_RE.exec(constructorSource); match !== null; match = THIS_ASSIGN_RE.exec(constructorSource)) {
    const propName = match[1];
    if (!propName) continue;
    const body = extractAssignmentBody(constructorSource, match.index + match[0].length);
    if (!result.previousButtonMethod && body.includes('skipNextButton') && body.includes('skipPreviousButton')) {
      result.previousButtonMethod = propName;
    } else if (!result.nextButtonMethod && body.includes('skipPreviousButton') && body.includes('skipNextButton')) {
      result.nextButtonMethod = propName;
    } else if (!result.engagementActionsMethod && body.includes('engagementActions')) {
      result.engagementActionsMethod = propName;
    }
    if (result.previousButtonMethod && result.nextButtonMethod && result.engagementActionsMethod) {
      break;
    }
  }

  return result;
}
