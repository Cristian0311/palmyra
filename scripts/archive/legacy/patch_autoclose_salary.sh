sed -i '/await state.closeSession(session.id, expected);/i \
          const employeeCommissions: Record<string, number> = {};\
          sessionTxs.forEach(tx => {\
            const sellers = tx.sellerEmployeeIds && tx.sellerEmployeeIds.length > 0 ? tx.sellerEmployeeIds : [tx.userId];\
            const splitFactor = sellers.length;\
            tx.items.forEach(item => {\
              let itemComm = 0;\
              if (item.product.commissionType === '"'"'fixed'"'"') {\
                itemComm = (item.product.commissionValue || 0) * item.quantity;\
              } else {\
                itemComm = (item.product.price * ((item.product.commissionValue || 0) / 100)) * item.quantity;\
              }\
              const splitComm = itemComm / splitFactor;\
              sellers.forEach(sellerId => {\
                if (!employeeCommissions[sellerId]) employeeCommissions[sellerId] = 0;\
                employeeCommissions[sellerId] += splitComm;\
              });\
            });\
          });\
          const employeesToSettle = new Set<string>();\
          if (session.workingEmployeeIds) {\
            session.workingEmployeeIds.forEach(id => employeesToSettle.add(id));\
          }\
          Object.keys(employeeCommissions).forEach(id => employeesToSettle.add(id));\
          if (employeesToSettle.size === 0) employeesToSettle.add(session.userId);\
          employeesToSettle.forEach(empId => {\
            const emp = state.users.find(u => u.id === empId);\
            if (!emp || emp.role === '"'"'admin'"'"') return;\
            const baseSalary = emp.baseSalary || 0;\
            const comm = employeeCommissions[empId] || 0;\
            state.addSalarySettlement({\
              id: crypto.randomUUID(),\
              userId: empId,\
              userName: emp.name || '"'"'Usuario'"'"',\
              sessionId: session.id,\
              baseSalary,\
              commissions: comm,\
              total: baseSalary + comm,\
              date: new Date().toISOString(),\
              status: '"'"'pending'"'"'\
            });\
          });\
' src/store/useStore.ts
