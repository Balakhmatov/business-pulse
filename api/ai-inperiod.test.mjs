import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInPeriodFacts } from './ai-inperiod.mjs';

test('In-period analysis is defined',()=>assert.equal(typeof buildInPeriodFacts,'function'));
