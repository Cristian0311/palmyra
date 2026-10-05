import { useCallback, useMemo } from 'react';
import type { CashRegisterSession, Transaction, User } from '../../types';
import { getLocalDateYMD } from '../../utils/dateUtils';

export function buildSessionTurnMap(
  sessions: CashRegisterSession[],
): Map<string, string> {
  const map = new Map<string, string>();
  sessions.forEach(session => {
    const turnNumber = Number(session.turnNumber);
    if (Number.isFinite(turnNumber) && turnNumber > 0) {
      map.set(session.id, `Turno-${Math.trunc(turnNumber)}`);
    } else {
      map.set(session.id, session.id);
    }
  });
  return map;
}

export function useReportsSessions(params: {
  cashSessions: CashRegisterSession[];
  transactions: Transaction[];
  userById: Map<string, User>;
  userByName: Map<string, User>;
  statusFilter: 'all' | 'open' | 'closed' | 'cancelled';
  selectedBranchFilter: string;
  selectedWorkerFilter: string;
  selectedFilterDate: string;
  sessionFilter: 'all' | 'today' | 'yesterday' | 'custom';
}) {
  const {
    cashSessions,
    transactions,
    userById,
    userByName,
    statusFilter,
    selectedBranchFilter,
    selectedWorkerFilter,
    selectedFilterDate,
    sessionFilter,
  } = params;

  const reconciledSessions = useMemo(() => {
    const sessionMap = new Map<string, CashRegisterSession>();

    cashSessions.forEach(session => {
      if (!session.deletedAt) sessionMap.set(session.id, session);
    });

    // Recover a display-only session when a sale still references a missing
    // cash session. Never invent a persistent turn number for this case.
    transactions.forEach(transaction => {
      if (
        transaction.sessionId &&
        !sessionMap.has(transaction.sessionId) &&
        !transaction.deletedAt
      ) {
        sessionMap.set(transaction.sessionId, {
          id: transaction.sessionId,
          userId: transaction.userId || 'recovered',
          workerName: transaction.cashierName || 'Vendedor',
          branchId: transaction.branchId || 'b1',
          openedAt: transaction.date,
          openingBalance: 0,
          openingAmount: 0,
          status: 'closed',
          closedAt: transaction.date,
          closingDate: transaction.date,
        });
      }
    });

    return Array.from(sessionMap.values());
  }, [cashSessions, transactions]);

  const sessionTurnMap = useMemo(
    () => buildSessionTurnMap(reconciledSessions),
    [reconciledSessions],
  );

  const getSessionTurnNumber = useCallback(
    (session: CashRegisterSession) => {
      const persisted = Number(session.turnNumber);
      if (Number.isFinite(persisted) && persisted > 0) return Math.trunc(persisted);
      return Number.MAX_SAFE_INTEGER;
    },
    []
  );

  const sortSessionsByTurn = useCallback(
    (a: CashRegisterSession, b: CashRegisterSession) => {
      const turnA = getSessionTurnNumber(a);
      const turnB = getSessionTurnNumber(b);
      if (turnA !== turnB) return turnA - turnB;

      const openedA = new Date(a.openedAt || a.closedAt || '').getTime();
      const openedB = new Date(b.openedAt || b.closedAt || '').getTime();
      if (openedA !== openedB) return openedA - openedB;
      return a.id.localeCompare(b.id);
    },
    [getSessionTurnNumber]
  );

  const closedSessions = useMemo(
    () =>
      [...reconciledSessions]
        .filter(session => session.status === 'closed' && !session.deletedAt)
        .sort(sortSessionsByTurn),
    [reconciledSessions, sortSessionsByTurn]
  );

  const filteredSessions = useMemo(() => {
    const todayYMD = getLocalDateYMD(new Date().toISOString());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayYMD = getLocalDateYMD(yesterdayDate.toISOString());

    return [...reconciledSessions]
      .filter(session => {
        if (session.deletedAt) return false;
        if (statusFilter !== 'all' && session.status !== statusFilter) return false;
        if (selectedBranchFilter !== 'all' && session.branchId !== selectedBranchFilter) return false;

        if (selectedWorkerFilter !== 'all') {
          const employee =
            userById.get(session.userId) ||
            (session.workerName
              ? userByName.get(session.workerName.trim().toLowerCase())
              : undefined);
          if (
            employee?.id !== selectedWorkerFilter &&
            session.userId !== selectedWorkerFilter &&
            session.workerName !== selectedWorkerFilter
          ) {
            return false;
          }
        }

        const sessionDate = getLocalDateYMD(
          session.closingDate || session.closedAt || session.openedAt
        );

        if (selectedFilterDate) return sessionDate === selectedFilterDate;
        if (sessionFilter === 'today') return sessionDate === todayYMD;
        if (sessionFilter === 'yesterday') return sessionDate === yesterdayYMD;
        return true;
      })
      .sort(sortSessionsByTurn);
  }, [
    reconciledSessions,
    statusFilter,
    selectedBranchFilter,
    selectedWorkerFilter,
    selectedFilterDate,
    sessionFilter,
    userById,
    userByName,
    sortSessionsByTurn,
  ]);

  const filteredClosedSessions = useMemo(
    () => filteredSessions.filter(session => session.status === 'closed'),
    [filteredSessions]
  );

  return {
    reconciledSessions,
    sessionTurnMap,
    getSessionTurnNumber,
    sortSessionsByTurn,
    closedSessions,
    filteredSessions,
    filteredClosedSessions,
  };
}
