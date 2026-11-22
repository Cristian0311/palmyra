import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionTurnMap } from '../../src/modules/reports/useReportsSessions';
import {
  buildSessionTurnLabelMap,
  getSessionTurnLabel
} from '../../src/modules/reports/utils/sessionTurnLabels';

test('persisted turn numbers keep their label and never fall back to the UUID', () => {
  const map = buildSessionTurnLabelMap([
    { id: 'session-uuid-1', turnNumber: 4, openedAt: '2026-11-18T10:00:00Z' },
    { id: 'session-uuid-2', turnNumber: 9, openedAt: '2026-11-18T11:00:00Z' }
  ] as any);
  assert.equal(map.get('session-uuid-1'), 'Turno-4');
  assert.equal(map.get('session-uuid-2'), 'Turno-9');
  assert.equal(buildSessionTurnMap([{ id: 'only-session', openedAt: '2026-11-18T10:00:00Z' } as any]).get('only-session'), 'Turno-1');
});

test('offline shifts without turnNumber are numbered by chronological position', () => {
  const map = buildSessionTurnLabelMap([
    { id: 'c', openedAt: '2026-11-18T12:00:00Z' },
    { id: 'a', openedAt: '2026-11-18T10:00:00Z' },
    { id: 'b', openedAt: '2026-11-18T11:00:00Z' }
  ] as any);
  assert.equal(map.get('a'), 'Turno-1');
  assert.equal(map.get('b'), 'Turno-2');
  assert.equal(map.get('c'), 'Turno-3');
});

test('fallback numbering skips turn numbers confirmed by the server', () => {
  const map = buildSessionTurnLabelMap([
    { id: 'first', turnNumber: 1, openedAt: '2026-11-18T10:00:00Z' },
    { id: 'offline', openedAt: '2026-11-18T11:00:00Z' },
    { id: 'third', turnNumber: 3, openedAt: '2026-11-18T12:00:00Z' }
  ] as any);
  assert.equal(map.get('first'), 'Turno-1');
  assert.equal(map.get('offline'), 'Turno-2');
  assert.equal(map.get('third'), 'Turno-3');
  // A fallback that would collide with a persisted number moves forward.
  const collision = buildSessionTurnLabelMap([
    { id: 'no-number', openedAt: '2026-11-18T09:00:00Z' },
    { id: 'persisted-one', turnNumber: 1, openedAt: '2026-11-18T10:00:00Z' }
  ] as any);
  assert.equal(collision.get('persisted-one'), 'Turno-1');
  assert.equal(collision.get('no-number'), 'Turno-2');
});

test('recovered sessions without openedAt get a deterministic label, never the UUID', () => {
  const sessions = [
    { id: 'uuid-zzz', openedAt: undefined, status: 'closed' },
    { id: 'real-session', turnNumber: 2, openedAt: '2026-11-18T10:00:00Z' },
    { id: 'uuid-aaa', openedAt: null, status: 'closed' }
  ] as any;
  const map = buildSessionTurnLabelMap(sessions);
  assert.equal(map.get('real-session'), 'Turno-2');
  assert.equal(map.get('uuid-aaa'), 'Turno-3');
  assert.equal(map.get('uuid-zzz'), 'Turno-4');
  const labels = [...map.values()];
  assert.equal(new Set(labels).size, labels.length);
  labels.forEach(label => assert.match(label, /^Turno-\d+$/));

  // Deterministic regardless of the input array order.
  const reversed = buildSessionTurnLabelMap([...sessions].reverse());
  assert.equal(reversed.get('uuid-aaa'), 'Turno-3');
  assert.equal(reversed.get('uuid-zzz'), 'Turno-4');
});

test('getSessionTurnLabel always returns a human label', () => {
  assert.equal(getSessionTurnLabel({ id: 'uuid', turnNumber: 7 } as any), 'Turno-7');
  assert.equal(getSessionTurnLabel({ id: 'uuid' } as any), 'Turno');
  assert.equal(getSessionTurnLabel({ id: 'uuid' } as any, new Map([['uuid', 'Turno-9']])), 'Turno-9');
  assert.notEqual(getSessionTurnLabel({ id: 'uuid' } as any), 'uuid');
});
