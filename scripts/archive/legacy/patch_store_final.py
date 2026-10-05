import re

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

# 1. Update setOfflineStatus
old_set_offline = """setOfflineStatus: (status) => {
    set({ isOffline: status });
    if (!status) {
      get().processSyncQueue();
    }
  },"""

new_set_offline = """setOfflineStatus: (status) => {
    set({ isOffline: status });
    if (!status) {
      // Pequeno retraso para asegurar que la conexión sea estable antes de procesar la cola
      setTimeout(() => get().processSyncQueue(), 1000);
    }
  },"""
content = content.replace(old_set_offline, new_set_offline)

# 2. Add sync trigger at the end of initializeFromSupabase
old_init_end = """      set({ isInitialized: true });
    }
  }
}),"""

new_init_end = """      set({ isInitialized: true });
      get().processSyncQueue();
    }
  }
}),"""
content = content.replace(old_init_end, new_init_end)

with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
