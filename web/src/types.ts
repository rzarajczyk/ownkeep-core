export type NoteType = 'TEXT' | 'LIST'
export type AttachmentKind = 'IMAGE' | 'FILE'

export type UserRole = 'ADMIN' | 'USER'

export interface KdfParams {
  alg: 'argon2id'
  m: number
  t: number
  p: number
}

export interface VaultInfo {
  kdfSalt: string | null
  kdfParams: KdfParams | null
  wrappedVaultKey: string | null
  wrappedVaultKeyRecovery: string | null
  hasRecoveryKey: boolean
  initialized: boolean
  needsRecoveryUnlock: boolean
}

export interface User {
  id: number
  email: string
  role: UserRole
  vault: VaultInfo
}

export interface ManagedUser {
  id: number
  email: string
  role: UserRole
  enabled: boolean
  emailVerified: boolean
  recoveryPending: boolean
  canRestore: boolean
  deletedAt?: string | null
}

export interface AuthSession {
  token: string
  expiresAt: string
  user: User
  recoveryRequired: boolean
}

export interface RestoreUserResponse {
  user: ManagedUser
  temporaryPassword: string
}

export interface ChecklistItem {
  id: string
  text: string
  /** Client-rendered inline HTML for card preview; empty while editing locally. */
  textRendered: string
  checked: boolean
  sortOrder: number
  indent: number
}

export interface Attachment {
  id: string
  kind: AttachmentKind
  originalFilename: string
  mimeType: string
  sizeBytes: number
  createdAt: string
  url: string
  metaCiphertext?: string
}

export interface Note {
  id: string
  type: NoteType
  title: string
  contentRaw: string
  contentRendered: string
  backgroundColor: string
  archived: boolean
  pinned: boolean
  labels: string[]
  labelIds: string[]
  createdAt: string
  updatedAt: string
  clientUpdatedAt?: string
  clientMutationId?: string | null
  version: number
  items: ChecklistItem[]
  attachments: Attachment[]
  wrappedNoteKey?: string
  ciphertext?: string
}

export interface NoteWrite {
  id?: string
  version?: number
  type?: NoteType
  title?: string
  contentRaw?: string
  backgroundColor?: string
  archived?: boolean
  pinned?: boolean
  labels?: string[]
  labelIds?: string[]
  items?: Array<Pick<ChecklistItem, 'id' | 'text' | 'checked' | 'sortOrder' | 'indent'>>
  /** When true, only metadata fields are patched (no ciphertext rewrite). */
  metadataOnly?: boolean
}

export interface EncryptedNoteWire {
  id: string
  type: NoteType
  backgroundColor: string
  archived: boolean
  pinned: boolean
  wrappedNoteKey: string
  ciphertext: string
  labelIds: string[]
  attachments: EncryptedAttachmentWire[]
  createdAt: string
  updatedAt: string
  clientUpdatedAt?: string
  clientMutationId?: string | null
  version: number
}

export interface EncryptedAttachmentWire {
  id: string
  metaCiphertext: string
  sizeBytes: number
  createdAt: string
  url: string
}

export interface EncryptedLabelWire {
  id: string
  ciphertext: string
  createdAt: string
}

export interface EncryptedNoteWrite {
  id?: string
  type: NoteType
  backgroundColor?: string
  archived?: boolean
  pinned?: boolean
  version?: number
  wrappedNoteKey?: string
  ciphertext?: string
  labelIds?: string[]
  clientUpdatedAt?: string
  clientMutationId?: string
}

export interface ConflictResolveRequest {
  version: number
  localRevisionId: string
  remoteRevisionId: string
  type: NoteType
  backgroundColor: string
  archived: boolean
  pinned: boolean
  wrappedNoteKey: string
  ciphertext: string
  localSnapshotCiphertext: string
  remoteSnapshotCiphertext: string
  labelIds?: string[]
  clientUpdatedAt: string
  clientMutationId: string
}

export interface ConflictResolveResponse {
  note: EncryptedNoteWire
  winner: 'local' | 'remote' | string
  localRevision: NoteRevisionSummary | null
  remoteRevision: NoteRevisionSummary | null
}

export type KeepImportStatus = 'VALIDATING' | 'RUNNING' | 'COMPLETED' | 'FAILED'

export interface KeepImportAccepted {
  jobId: string
  status: KeepImportStatus
  statusUrl: string
}

export interface KeepImportJob {
  jobId: string
  status: KeepImportStatus
  totalNotes: number
  processedNotes: number
  importedNotes: number
  skippedNotes: number
  warningCount: number
  warnings: string[]
  progressPercent: number
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface NotesPage {
  items: EncryptedNoteWire[]
  deletedIds: string[]
  nextUpdatedAfter: string | null
  nextAfterId: string | null
  hasMore: boolean
}

export interface NoteRevisionSummary {
  id: string
  createdAt: string
  sourceVersion: number
  labelCiphertext: string | null
  origin?: string
}

export interface CreateNoteRevisionRequest {
  id: string
  sourceVersion: number
  wrappedNoteKey: string
  snapshotCiphertext: string
}

export interface CreateNoteRevisionResponse {
  created: boolean
  revision: NoteRevisionSummary
}

export interface NoteRevisionPage {
  items: NoteRevisionSummary[]
  nextCreatedAt: string | null
  nextAfterId: string | null
  hasMore: boolean
}

export interface NoteRevisionDetail extends NoteRevisionSummary {
  wrappedNoteKey: string
  snapshotCiphertext: string
}

export interface RestoreNoteRevisionRequest {
  expectedVersion: number
  undoRevision: CreateNoteRevisionRequest
  type: NoteType
  backgroundColor: string
  archived: boolean
  pinned: boolean
  wrappedNoteKey: string
  ciphertext: string
  labelIds: string[]
  attachmentIds: string[]
}

export interface RestoreNoteRevisionResponse {
  note: EncryptedNoteWire
  unavailableAttachmentIds: string[]
}
