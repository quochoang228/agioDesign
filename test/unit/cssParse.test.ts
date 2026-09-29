import { test } from 'node:test';
import assert from 'node:assert/strict';
import { px, splitTopLevelCommas, parseGradientAngle, mapFontWeight, bgScaleMode } from '../../src/ui/cssParse';

test('px parses numbers and falls back to 0', () => {
  assert.equal(px('12.5px'), 12.5);
  assert.equal(px('auto'), 0);
});

test('splitTopLevelCommas keeps commas inside functions and data URIs', () => {
  assert.deepEqual(
    splitTopLevelCommas('linear-gradient(90deg, rgba(0,0,0,.5), red), url(data:image/png;base64,AA,BB)'),
    ['linear-gradient(90deg, rgba(0,0,0,.5), red)', 'url(data:image/png;base64,AA,BB)'],
  );
  assert.deepEqual(splitTopLevelCommas('0 1px 2px #000,  inset 0 0 1px red'), ['0 1px 2px #000', 'inset 0 0 1px red']);
  assert.deepEqual(splitTopLevelCommas(''), []);
});

test('parseGradientAngle handles deg, keywords, turn, rad and default', () => {
  assert.equal(parseGradientAngle('45deg'), 45);
  assert.equal(parseGradientAngle('-90deg'), 270);
  assert.equal(parseGradientAngle('to top right'), 45);
  assert.equal(parseGradientAngle('to left'), 270);
  assert.equal(parseGradientAngle('0.25turn'), 90);
  assert.ok(Math.abs(parseGradientAngle(`${Math.PI}rad`) - 180) < 1e-9);
  assert.equal(parseGradientAngle('red'), 180);
});

test('mapFontWeight maps keywords and numbers', () => {
  assert.equal(mapFontWeight('normal'), 400);
  assert.equal(mapFontWeight('bold'), 700);
  assert.equal(mapFontWeight('600'), 600);
  assert.equal(mapFontWeight('bolder'), 400);
});

test('bgScaleMode maps background-size/repeat to Figma scale modes', () => {
  assert.equal(bgScaleMode('contain', 'no-repeat'), 'FIT');
  assert.equal(bgScaleMode('cover', 'repeat'), 'FILL');
  assert.equal(bgScaleMode('auto', 'repeat-x'), 'TILE');
  assert.equal(bgScaleMode('auto', 'no-repeat'), 'FILL');
});
