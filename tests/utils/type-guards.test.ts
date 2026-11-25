import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { isObjectLike, isRecord, readRecordPath } from '../../mods/utils/type-guards.ts';

describe('type-guards', () => {
  afterEach(() => {});

  test('isObjectLike accepts non-null objects and functions and rejects arrays, primitives, and null', () => {
    assert.equal(isObjectLike({}), true);
    assert.equal(
      isObjectLike(() => {}),
      true
    );
    assert.equal(isObjectLike([]), false);
    assert.equal(isObjectLike(null), false);
    assert.equal(isObjectLike(undefined), false);
    assert.equal(isObjectLike('str'), false);
    assert.equal(isObjectLike(42), false);
  });

  test('isRecord accepts plain objects and rejects null, arrays, functions, and primitives', () => {
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord([]), false);
    assert.equal(
      isRecord(() => {}),
      false
    );
    assert.equal(isRecord('abc'), false);
    assert.equal(isRecord(123), false);
  });

  test('readRecordPath walks nested records safely and returns null on missing or non-record hops', () => {
    const obj = {
      a: {
        b: {
          c: { value: 'ok' },
          arr: [1, 2],
        },
      },
    };
    assert.deepEqual(readRecordPath(obj, 'a', 'b', 'c'), { value: 'ok' });
    assert.equal(readRecordPath(obj, 'a', 'b', 'arr'), null);
    assert.equal(readRecordPath(obj, 'a', 'missing', 'c'), null);
    assert.equal(readRecordPath(null, 'a'), null);
  });
});
