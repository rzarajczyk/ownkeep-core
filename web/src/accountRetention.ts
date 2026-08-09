export const DELETED_USER_RETENTION_DAYS = 60

const adminRestoreWindowCopy =
  'An administrator can restore the account during that window, but you will have to provide the restore code to unlock your notes.'

const adminRestoreWindowCopyForOtherUser =
  'An administrator can restore the account during that window, but they will have to provide the restore code to unlock their notes.'

export const deletedAccountRetentionCopy =
  `Your account is disabled immediately. Your encrypted notes are kept for ${DELETED_USER_RETENTION_DAYS} days. ` +
  `${adminRestoreWindowCopy} After ${DELETED_USER_RETENTION_DAYS} days, the account and its data are permanently deleted and cannot be restored.`

export function softDeleteUserConfirmation(email: string) {
  return (
    `Delete user “${email}”? They will be disabled immediately.\n\n` +
    `${adminRestoreWindowCopyForOtherUser} After ${DELETED_USER_RETENTION_DAYS} days, it is permanently deleted and cannot be restored.`
  )
}
