import { i18n } from './i18n'

export const DELETED_USER_RETENTION_DAYS = 60

export function deletedAccountRetentionCopy() {
  return i18n.t('settings.retention.body', { days: DELETED_USER_RETENTION_DAYS })
}

export function softDeleteUserConfirmation(email: string) {
  return i18n.t('settings.retention.softDeleteConfirm', {
    email,
    days: DELETED_USER_RETENTION_DAYS,
  })
}
