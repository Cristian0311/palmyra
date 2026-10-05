import re

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

# 1. Update setOfflineStatus to trigger sync
old_set_offline = "setOfflineStatus: (status) => set({ isOffline: status }),"
new_set_offline = """setOfflineStatus: (status) => {
    set({ isOffline: status });
    if (!status) {
      get().processSyncQueue();
    }
  },"""
content = content.replace(old_set_offline, new_set_offline)

# 2. Improve processSyncQueue error handling
# We want to catch the "Failed to fetch" error and break the loop
old_error_handling = """          if (error) {
            console.error(`[Sync Queue] Failed to process task ${task.id} (${task.table}):`, error);
            set(s => ({
              syncQueue: s.syncQueue.map(t => t.id === task.id ? { ...t, retryCount: (t.retryCount || 0) + 1 } : t)
            }));
          } else {"""

new_error_handling = """          if (error) {
            console.error(`[Sync Queue] Failed to process task ${task.id} (${task.table}):`, error);
            
            // If it's a network error, stop processing the queue for now
            const errorMsg = typeof error === 'object' && error !== null ? (error as any).message : String(error);
            const isNetworkError = errorMsg.includes('Failed to fetch') || errorMsg.includes('network');
            
            set(s => ({
              syncQueue: s.syncQueue.map(t => t.id === task.id ? { ...t, retryCount: (t.retryCount || 0) + 1 } : t)
            }));

            if (isNetworkError) {
              console.warn('[Sync Queue] Network error detected, pausing queue processing.');
              break; 
            }
          } else {"""

# Replace the block. Since there are multiple similar patterns, we use a more precise match or replace carefully.
# In our case, it's inside the processSyncQueue loop.
content = content.replace(old_error_handling, new_error_handling)

with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
