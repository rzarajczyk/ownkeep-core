import type {
  AuthSession,
  EncryptedAttachmentWire,
  EncryptedLabelWire,
  EncryptedNoteWire,
  EncryptedNoteWrite,
  KdfParams,
  ManagedUser,
  NoteRevisionDetail,
  NoteRevisionPage,
  NoteRevisionSummary,
  NotesPage,
  CreateNoteRevisionRequest,
  CreateNoteRevisionResponse,
  RestoreNoteRevisionRequest,
  RestoreNoteRevisionResponse,
  RestoreUserResponse,
  User,
  VaultInfo,
} from './types'

const API_PREFIX = '/api'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, status: number, details?: unknown, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.code =
      code ??
      (details && typeof details === 'object' && details !== null && 'code' in details
        ? String((details as { code: unknown }).code)
        : undefined)
  }
}

type UnauthorizedHandler = () => void

class ApiClient {
  private token: string | null = null
  private unauthorizedHandler: UnauthorizedHandler | null = null

  setToken(token: string | null) {
    this.token = token
  }

  onUnauthorized(handler: UnauthorizedHandler | null) {
    this.unauthorizedHandler = handler
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    notifyUnauthorized = true,
  ): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
    }
    if (authenticated && this.token) {
      headers.set('Authorization', `Bearer ${this.token}`)
    }

    let response: Response
    try {
      response = await fetch(`${API_PREFIX}${path}`, { ...init, headers })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError('Unable to reach OwnKeep. Check your connection.', 0, error, 'connection_failed')
    }

    if (response.status === 401 && authenticated && notifyUnauthorized) {
      this.unauthorizedHandler?.()
    }
    if (!response.ok) {
      const details = await response.json().catch(() => null)
      const hasCode =
        details && typeof details === 'object' && details !== null && 'code' in details
      const message =
        details && typeof details === 'object' && 'message' in details
          ? String(details.message)
          : response.status === 401
            ? 'Your session has expired. Please sign in again.'
            : `Request failed (${response.status})`
      const fallbackCode =
        response.status === 401 ? 'session_expired' : 'request_failed'
      throw new ApiError(
        message,
        response.status,
        details ?? { status: response.status },
        hasCode ? undefined : fallbackCode,
      )
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  login(email: string, password: string, signal?: AbortSignal) {
    return this.request<AuthSession>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }), signal },
      false,
    )
  }

  verifyEmail(token: string, signal?: AbortSignal) {
    return this.request<void>(
      '/auth/email/verify',
      { method: 'POST', body: JSON.stringify({ token }), signal },
      false,
    )
  }

  resendVerification(email: string, signal?: AbortSignal) {
    return this.request<void>(
      '/auth/email/resend',
      { method: 'POST', body: JSON.stringify({ email }), signal },
      false,
    )
  }

  logout() {
    return this.request<void>('/auth/logout', { method: 'POST' })
  }

  completeRecovery(newPassword: string, wrappedVaultKey: string) {
    return this.request<AuthSession>(
      '/auth/recovery/complete',
      {
        method: 'POST',
        body: JSON.stringify({ newPassword, wrappedVaultKey }),
      },
      true,
      false,
    )
  }

  async me(signal?: AbortSignal) {
    return this.request<User>('/me', { signal })
  }

  initializeVault(payload: {
    kdfSalt: string
    kdfParams: KdfParams
    wrappedVaultKey: string
    wrappedVaultKeyRecovery: string
  }) {
    return this.request<VaultInfo>('/me/vault', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  updateVaultWrap(payload: {
    wrappedVaultKey: string
    wrappedVaultKeyRecovery?: string
  }) {
    return this.request<VaultInfo>('/me/vault/wrap', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  }

  changePassword(currentPassword: string, newPassword: string, wrappedVaultKey: string) {
    return this.request<void>('/me/password', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword, wrappedVaultKey }),
    })
  }

  deleteAccount(password: string) {
    return this.request<void>('/me', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    })
  }

  listUsers(signal?: AbortSignal) {
    return this.request<ManagedUser[]>('/users', { signal })
  }

  createUser(email: string, password: string) {
    return this.request<ManagedUser>('/users', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  }

  resendUserVerification(id: number) {
    return this.request<void>(`/users/${id}/resend-verification`, {
      method: 'POST',
    })
  }

  deleteUser(id: number) {
    return this.request<ManagedUser>(`/users/${id}`, { method: 'DELETE' })
  }

  restoreUser(id: number) {
    return this.request<RestoreUserResponse>(`/users/${id}/restore`, {
      method: 'POST',
    })
  }

  permanentlyDeleteUser(id: number) {
    return this.request<void>(`/users/${id}/permanent`, {
      method: 'DELETE',
    })
  }

  resetUserPassword(id: number, newPassword: string) {
    return this.request<void>(`/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    })
  }

  async notes(
    params: {
      archived?: boolean
      limit?: number
      updatedAfter?: string
      afterId?: string
    },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: String(params.limit ?? 100) })
    if (params.archived !== undefined) query.set('archived', String(params.archived))
    if (params.updatedAfter) query.set('updated_after', params.updatedAfter)
    if (params.afterId) query.set('after_id', params.afterId)
    const page = await this.request<Partial<NotesPage>>(`/notes?${query}`, {
      signal,
    })
    return {
      items: page.items ?? [],
      deletedIds: page.deletedIds ?? [],
      nextUpdatedAfter: page.nextUpdatedAfter ?? null,
      nextAfterId: page.nextAfterId ?? null,
      hasMore: page.hasMore ?? false,
    } satisfies NotesPage
  }

  createNote(payload: EncryptedNoteWrite) {
    return this.request<EncryptedNoteWire>('/notes', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  note(id: string, signal?: AbortSignal) {
    return this.request<EncryptedNoteWire>(`/notes/${encodeURIComponent(id)}`, { signal })
  }

  updateNote(id: string, payload: EncryptedNoteWrite, signal?: AbortSignal) {
    return this.request<EncryptedNoteWire>(`/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
      signal,
    })
  }

  deleteNote(id: string) {
    return this.request<void>(`/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  createNoteRevision(noteId: string, payload: CreateNoteRevisionRequest) {
    return this.request<CreateNoteRevisionResponse>(
      `/notes/${encodeURIComponent(noteId)}/revisions`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  }

  listNoteRevisions(
    noteId: string,
    params: { createdBefore?: string; afterId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: String(params.limit ?? 50) })
    if (params.createdBefore) query.set('created_before', params.createdBefore)
    if (params.afterId) query.set('after_id', params.afterId)
    return this.request<NoteRevisionPage>(
      `/notes/${encodeURIComponent(noteId)}/revisions?${query}`,
      { signal },
    )
  }

  getNoteRevision(noteId: string, revisionId: string, signal?: AbortSignal) {
    return this.request<NoteRevisionDetail>(
      `/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}`,
      { signal },
    )
  }

  updateNoteRevisionLabel(noteId: string, revisionId: string, labelCiphertext: string | null) {
    return this.request<NoteRevisionSummary>(
      `/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ labelCiphertext }),
      },
    )
  }

  restoreNoteRevision(noteId: string, revisionId: string, payload: RestoreNoteRevisionRequest) {
    return this.request<RestoreNoteRevisionResponse>(
      `/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    )
  }

  listLabels(signal?: AbortSignal) {
    return this.request<EncryptedLabelWire[]>('/labels', { signal })
  }

  createLabel(ciphertext: string) {
    return this.request<EncryptedLabelWire>('/labels', {
      method: 'POST',
      body: JSON.stringify({ ciphertext }),
    })
  }

  updateLabel(id: string, ciphertext: string) {
    return this.request<EncryptedLabelWire>(`/labels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ciphertext }),
    })
  }

  deleteLabel(id: string) {
    return this.request<void>(`/labels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  uploadAttachment(
    noteId: string,
    file: Blob,
    metaCiphertext: string,
    attachmentId: string,
    onProgress: (progress: number) => void,
  ): Promise<EncryptedAttachmentWire> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open(
        'POST',
        `${API_PREFIX}/notes/${encodeURIComponent(noteId)}/attachments`,
      )
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
      }
      xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0, undefined, 'upload_failed'))
      xhr.onload = () => {
        if (xhr.status === 401) this.unauthorizedHandler?.()
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `Upload failed (${xhr.status})`
          let details: unknown
          try {
            details = JSON.parse(xhr.responseText) as { message?: string; code?: string }
            if (
              details &&
              typeof details === 'object' &&
              'message' in details &&
              details.message
            ) {
              message = String(details.message)
            }
          } catch {
            // Keep the status-based message for non-JSON responses.
          }
          const hasCode =
            details && typeof details === 'object' && details !== null && 'code' in details
          reject(
            new ApiError(
              message,
              xhr.status,
              details ?? { status: xhr.status },
              hasCode ? undefined : 'upload_failed',
            ),
          )
          return
        }
        try {
          resolve(JSON.parse(xhr.responseText) as EncryptedAttachmentWire)
        } catch {
          reject(
            new ApiError(
              'The server returned an invalid upload response.',
              xhr.status,
              undefined,
              'invalid_upload_response',
            ),
          )
        }
      }
      const body = new FormData()
      body.append('file', file, 'attachment.bin')
      body.append('metaCiphertext', metaCiphertext)
      body.append('attachmentId', attachmentId)
      xhr.send(body)
    })
  }

  deleteAttachment(id: string) {
    return this.request<void>(`/attachments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async attachmentCipherBlob(attachmentId: string, url: string, signal?: AbortSignal) {
    const path = url.startsWith('/api')
      ? url.slice(API_PREFIX.length)
      : `/attachments/${encodeURIComponent(attachmentId)}`
    const headers = new Headers()
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await fetch(`${API_PREFIX}${path}`, { headers, signal })
    if (response.status === 401) this.unauthorizedHandler?.()
    if (!response.ok) {
      throw new ApiError('Could not load attachment.', response.status, undefined, 'attachment_load_failed')
    }
    return response.arrayBuffer()
  }

  async retainedAttachmentCipherBlob(noteId: string, attachmentId: string, signal?: AbortSignal) {
    const headers = new Headers()
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    const response = await fetch(
      `${API_PREFIX}/notes/${encodeURIComponent(noteId)}/retained-attachments/${encodeURIComponent(attachmentId)}`,
      { headers, signal },
    )
    if (response.status === 401) this.unauthorizedHandler?.()
    if (!response.ok) {
      throw new ApiError('Could not load attachment.', response.status, undefined, 'attachment_load_failed')
    }
    return response.arrayBuffer()
  }
}

export const api = new ApiClient()
