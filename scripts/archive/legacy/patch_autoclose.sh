sed -i '/set({ isInitialized: true });/i \
      // Autocierre de sesiones antiguas\
      try {\
        const today = new Date().toDateString();\
        const state = get();\
        const oldOpenSessions = state.cashSessions.filter(s => s.status === '"'open'"' && new Date(s.openedAt).toDateString() !== today);\
        for (const session of oldOpenSessions) {\
          console.log(`Auto-closing old session ${session.id} from ${session.openedAt}`);\
          const expected: import('"'"'../types'"'"').Payment[] = [\
            { currencyCode: state.getBaseCurrency().code as any, amount: session.openingBalance, exchangeRate: 1, method: '"'"'cash'"'"' as any }\
          ];\
          const sessionTxs = state.transactions.filter(\
            t => t.branchId === session.branchId && t.userId === session.userId && new Date(t.date) >= new Date(session.openedAt)\
          );\
          sessionTxs.forEach(tx => {\
            tx.payments.forEach(p => {\
              const exItem = expected.find(e => e.currencyCode === p.currencyCode && e.method === p.method);\
              if (exItem) {\
                exItem.amount += p.amount;\
              } else {\
                expected.push({ currencyCode: p.currencyCode, amount: p.amount, exchangeRate: p.exchangeRate, method: p.method });\
              }\
            });\
          });\
          const movements = state.cashSessions.find(s => s.id === session.id)?.movements || [];\
          movements.forEach(m => {\
            const exItem = expected.find(e => e.currencyCode === m.currencyCode && e.method === '"'"'cash'"'"');\
            const multiplier = m.type === '"'"'income'"'"' ? 1 : -1;\
            if (exItem) {\
              exItem.amount += (m.amount * multiplier);\
            } else {\
              const currency = state.currencies.find(c => c.code === m.currencyCode);\
              expected.push({ currencyCode: m.currencyCode as any, amount: m.amount * multiplier, exchangeRate: currency?.rateToBase || 1, method: '"'"'cash'"'"' as any });\
            }\
          });\
          await state.closeSession(session.id, expected);\
        }\
      } catch (err) {\
        console.error('"'"'Error auto-closing old sessions:'"'"', err);\
      }\
' src/store/useStore.ts
