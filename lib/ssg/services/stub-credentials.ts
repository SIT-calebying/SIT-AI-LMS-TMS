/**
 * Stub: SSG Credentials Service — returns safe defaults so SSG API modules
 * compile without real credentials and short-circuit any runtime calls.
 */

export interface SSGCredentials {
  uen: string;
  encryptionKey?: string | null;
  certificateContent?: string | null;
  privateKeyContent?: string | null;
}

const STUB_CREDENTIALS: SSGCredentials = {
  uen: '20231704A', // SIT test UEN placeholder
};

let currentCredentials: SSGCredentials = STUB_CREDENTIALS;

export function getSSGCredentialsService() {
  return {
    async getSSGCredentials(): Promise<SSGCredentials | undefined> {
      if (!currentCredentials.encryptionKey) {
        console.warn('[ssg/credentials] No SSG credentials configured — returning stub');
        return undefined;
      }
      return currentCredentials;
    },
    async setSSGCredentials(credentials: SSGCredentials): Promise<void> {
      currentCredentials = { ...credentials };
    },
  };
}
