/**
 * Every PALMYRA plan, including Gratis, backs up business data to the cloud.
 * Kept as one policy point so a future plan could be sold without cloud backup.
 */
export function isCloudBusinessSyncAllowed(): boolean {
  return true;
}
