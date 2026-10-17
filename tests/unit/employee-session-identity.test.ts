import assert from 'node:assert/strict';
import test from 'node:test';

import { findSessionEmployeeUser } from '../../src/services/employeeCompensation';
import type { User } from '../../src/types';

function user(overrides: Partial<User> & Pick<User, 'id' | 'name' | 'baseSalary'>): User {
  return {
    email: '',
    role: 'employee',
    ...overrides,
  };
}

test('session employee id wins over the shared account that opened the register', () => {
  const owner = user({ id: 'owner-auth-id', name: 'Administrador', baseSalary: 0, role: 'admin' });
  const veronica = user({ id: 'employee-veronica-id', employeeId: 'employee-veronica-pk', name: 'VERONICA', baseSalary: 4500 });

  const resolved = findSessionEmployeeUser({
    userId: owner.id,
    employeeId: 'employee-veronica-pk',
    workerName: 'VERONICA',
  }, [owner, veronica]);

  assert.equal(resolved?.id, 'employee-veronica-id');
  assert.equal(resolved?.baseSalary, 4500);
});

test('linked employee identity resolves by employees primary key, not only auth user id', () => {
  const owner = user({ id: 'owner-auth-id', name: 'Administrador', baseSalary: 0, role: 'admin' });
  const emily = user({ id: 'emily-auth-id', employeeId: 'emily-employee-pk', name: 'EMILY', baseSalary: 4500 });

  const resolved = findSessionEmployeeUser({
    userId: 'emily-auth-id',
    employeeId: 'emily-employee-pk',
    workerName: 'EMILY',
  }, [owner, emily]);

  assert.equal(resolved, emily);
});

test('legacy cached sessions resolve the named worker before falling back to opened_by', () => {
  const owner = user({ id: 'owner-auth-id', name: 'Administrador', baseSalary: 0, role: 'admin' });
  const elier = user({ id: 'elier-employee-pk', employeeId: 'elier-employee-pk', name: 'ELIER', baseSalary: 0 });

  const resolved = findSessionEmployeeUser({
    userId: owner.id,
    workerName: 'ELIER',
  }, [owner, elier]);

  assert.equal(resolved, elier);
});

test('generic worker labels do not override the fallback account identity', () => {
  const owner = user({ id: 'owner-auth-id', name: 'Administrador', baseSalary: 0, role: 'admin' });

  const resolved = findSessionEmployeeUser({
    userId: owner.id,
    workerName: 'Administrador',
  }, [owner]);

  assert.equal(resolved, owner);
});
