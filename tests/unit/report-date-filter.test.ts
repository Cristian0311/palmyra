import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesReportDateFilter } from '../../src/modules/reports/utils/reportDateFilter';

test('report date filter uses the chosen date ahead of quick filters', () => {
  assert.equal(
    matchesReportDateFilter('2026-10-15T12:00:00.000Z', '2026-10-15', 'today', new Date('2026-10-16T12:00:00.000Z')),
    true,
  );
  assert.equal(
    matchesReportDateFilter('2026-10-14T12:00:00.000Z', '2026-10-15', 'yesterday', new Date('2026-10-16T12:00:00.000Z')),
    false,
  );
});

test('today and yesterday quick filters select the expected calendar day', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');

  assert.equal(matchesReportDateFilter('2026-10-16T09:30:00.000Z', '', 'today', now), true);
  assert.equal(matchesReportDateFilter('2026-10-15T23:59:00.000Z', '', 'today', now), false);
  assert.equal(matchesReportDateFilter('2026-10-15T09:30:00.000Z', '', 'yesterday', now), true);
  assert.equal(matchesReportDateFilter('2026-10-14T23:59:00.000Z', '', 'yesterday', now), false);
});

test('all-history and empty custom filters do not exclude records', () => {
  assert.equal(matchesReportDateFilter('not-a-date', '', 'all', new Date('2026-10-16T12:00:00.000Z')), true);
  assert.equal(matchesReportDateFilter('not-a-date', '', 'custom', new Date('2026-10-16T12:00:00.000Z')), true);
});

test('invalid timestamps cannot match date-specific filters', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  assert.equal(matchesReportDateFilter('not-a-date', '', 'today', now), false);
  assert.equal(matchesReportDateFilter('not-a-date', '', 'yesterday', now), false);
});

test('date-input calendar values are not shifted by timezone parsing', () => {
  assert.equal(
    matchesReportDateFilter('2026-10-16', '2026-10-16', 'custom', new Date('2026-10-16T02:00:00.000Z')),
    true,
  );
});
