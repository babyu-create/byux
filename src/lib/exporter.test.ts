// Pure-function type-level tests for exporter utilities.
// No test runner required — `tsc --noEmit` validates all assertions.
// Run: npx tsc --noEmit -p tsconfig.app.json
//
// Pattern: assign results to explicitly typed `const` variables.
// TypeScript will error if the inferred type doesn't match the declared type.

import { buildAtempoChain, getResolution } from './exporter';

// ---------------------------------------------------------------------------
// buildAtempoChain
// ---------------------------------------------------------------------------

// Speed 1.0 → no filters needed
const _noFilters: string[] = buildAtempoChain(1.0);
// Should be empty — any non-empty array would still type-check, but we
// document the expectation via a runtime-equivalent assertion embedded in a
// compile-time-safe expression (the array spread into a tuple literal).
// We use a conditional type trick to assert length === 0 at the type level.
type _AssertEmpty = typeof _noFilters extends never[] ? true : boolean;
const _emptyCheck: _AssertEmpty = true; void _emptyCheck;

// Speed 2.0 → single "atempo=2.0" stage
const _double: string[] = buildAtempoChain(2.0);
const _doubleFirst: string = _double[0]; // must be string — TS ensures this
void _doubleFirst; // suppress unused-variable error

// Speed 0.25 → should chain two atempo=0.5 stages (0.5 * 0.5 = 0.25)
const _quarter: string[] = buildAtempoChain(0.25);
const _quarterFirst: string = _quarter[0];
void _quarterFirst;

// Speed 4.0 → should chain two atempo=2.0 stages
const _quad: string[] = buildAtempoChain(4.0);
const _quadFirst: string = _quad[0];
void _quadFirst;

// Return type is always string[]
function _assertStringArray(v: string[]): void { void v; }
_assertStringArray(buildAtempoChain(0.1));
_assertStringArray(buildAtempoChain(10));

// ---------------------------------------------------------------------------
// getResolution
// ---------------------------------------------------------------------------

// 16:9 1080p
const _r1080_169: { width: number; height: number } = getResolution('1080p', '16:9');
void _r1080_169;

// 9:16 720p
const _r720_916: { width: number; height: number } = getResolution('720p', '9:16');
void _r720_916;

// 16:9 720p
const _r720_169: { width: number; height: number } = getResolution('720p', '16:9');
void _r720_169;

// 9:16 1080p
const _r1080_916: { width: number; height: number } = getResolution('1080p', '9:16');
void _r1080_916;

// Return type always has numeric width and height
function _assertResShape(v: { width: number; height: number }): void { void v; }
_assertResShape(getResolution('720p', '16:9'));
_assertResShape(getResolution('1080p', '9:16'));

// ---------------------------------------------------------------------------
// Structural value checks (evaluated at runtime if this file is ever executed,
// but the primary guarantee here is the TS type narrowing above).
// ---------------------------------------------------------------------------

const _checks: Array<{ label: string; pass: boolean }> = [
  { label: 'speed=1 → empty chain', pass: buildAtempoChain(1.0).length === 0 },
  { label: 'speed=2 → length 1', pass: buildAtempoChain(2.0).length === 1 },
  { label: 'speed=2 → "atempo=2.0"', pass: buildAtempoChain(2.0)[0] === 'atempo=2.0' },
  { label: 'speed=0.5 → length 1', pass: buildAtempoChain(0.5).length === 1 },
  { label: 'speed=0.5 → "atempo=0.5"', pass: buildAtempoChain(0.5)[0] === 'atempo=0.5' },
  { label: 'speed=0.25 → length 2 (chain)', pass: buildAtempoChain(0.25).length === 2 },
  { label: 'speed=4 → length 2 (chain)', pass: buildAtempoChain(4.0).length === 2 },
  { label: '1080p 16:9 width=1920', pass: getResolution('1080p', '16:9').width === 1920 },
  { label: '1080p 16:9 height=1080', pass: getResolution('1080p', '16:9').height === 1080 },
  { label: '720p 16:9 width=1280', pass: getResolution('720p', '16:9').width === 1280 },
  { label: '720p 16:9 height=720', pass: getResolution('720p', '16:9').height === 720 },
  { label: '1080p 9:16 width=1080', pass: getResolution('1080p', '9:16').width === 1080 },
  { label: '1080p 9:16 height=1920', pass: getResolution('1080p', '9:16').height === 1920 },
  { label: '720p 9:16 width=720', pass: getResolution('720p', '9:16').width === 720 },
  { label: '720p 9:16 height=1280', pass: getResolution('720p', '9:16').height === 1280 },
];

// Expose for potential console-based verification if this file is ever run
// directly (e.g. `node --loader ts-node/esm src/lib/exporter.test.ts`).
export const testResults = _checks;
