export interface SyncResult {
  success: boolean;
  message: string;
  counts?: Record<string, number>;
  errors?: string[];
}
