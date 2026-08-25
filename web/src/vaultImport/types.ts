export type VaultImportMode = 'replace' | 'add'

export interface VaultImportProgress {
  phase: 'clearing' | 'importing'
  percent: number
}
