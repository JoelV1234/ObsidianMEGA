export interface SyncIndexEntry {
  remoteNodeId: string;
  remoteSize: number;
  localSize: number;
  localMtime: number;
}

export interface MegaSyncSettings {
  setupComplete: boolean;
  email: string | null;
  encryptedPassword: string | null;
  encryptedSession: string | null;
  remoteFolderPath: string | null;
  remoteFolderHandle: string | null;
  initialSyncComplete: boolean;
  syncIndex: Record<string, SyncIndexEntry>;
}

export const DEFAULT_SETTINGS: MegaSyncSettings = {
  setupComplete: false,
  email: null,
  encryptedPassword: null,
  encryptedSession: null,
  remoteFolderPath: null,
  remoteFolderHandle: null,
  initialSyncComplete: false,
  syncIndex: {},
};

export type SyncStatus = "idle" | "syncing" | "uploading" | "downloading" | "error" | "up-to-date";

export interface SyncProgress {
  status: SyncStatus;
  message: string;
  current?: number;
  total?: number;
  errorDetail?: string;
}

export interface RemoteFolderNode {
  name: string;
  path: string;
  handle: string;
}

export interface RemoteFolderTreeNode {
  name: string;
  path: string;
  handle: string;
  children: RemoteFolderTreeNode[];
}
