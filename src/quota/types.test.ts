import assert from 'node:assert/strict';
import test from 'node:test';
import { isCliAuthorizationRejectedStatus } from './types';

test('marks only HTTP 401 and 403 as explicit CLI authorization rejection', () => {
    assert.equal(isCliAuthorizationRejectedStatus(401), true);
    assert.equal(isCliAuthorizationRejectedStatus(403), true);
    assert.equal(isCliAuthorizationRejectedStatus(400), false);
    assert.equal(isCliAuthorizationRejectedStatus(404), false);
    assert.equal(isCliAuthorizationRejectedStatus(429), false);
    assert.equal(isCliAuthorizationRejectedStatus(500), false);
});
