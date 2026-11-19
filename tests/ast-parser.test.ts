import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extractPlayerActionMethodNames } from '../mods/utils/ast-parser.ts';

describe('extractPlayerActionMethodNames', () => {
  test('extracts previous, next, and engagement action method names from minified constructor source', () => {
    const ctorSource = `function YtlrActions(a) {
      this.props = a;
      this.Qa = function() {
        return {
          a: this.props.data.skipNextButton,
          b: this.props.data.skipPreviousButton
        };
      };
      this.Ra = function() {
        return {
          a: this.props.data.skipPreviousButton,
          b: this.props.data.skipNextButton
        };
      };
      this.Sa = () => this.props.data.engagementActions || [];
    }`;

    assert.deepEqual(extractPlayerActionMethodNames(ctorSource), {
      previousButtonMethod: 'Qa',
      nextButtonMethod: 'Ra',
      engagementActionsMethod: 'Sa',
    });
  });

  test('returns null fields cleanly when expected methods are missing', () => {
    const ctorSource = `class PartialActions {
      constructor() {
        this.onlyPrev = function() {
          return [this.props.skipNextButton, this.props.skipPreviousButton];
        }
      }
    }`;

    assert.deepEqual(extractPlayerActionMethodNames(ctorSource), {
      previousButtonMethod: 'onlyPrev',
      nextButtonMethod: null,
      engagementActionsMethod: null,
    });

    assert.deepEqual(extractPlayerActionMethodNames('function Empty() {}'), {
      previousButtonMethod: null,
      nextButtonMethod: null,
      engagementActionsMethod: null,
    });
  });
});
