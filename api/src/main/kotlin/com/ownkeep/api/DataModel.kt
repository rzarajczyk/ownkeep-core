package com.ownkeep.api

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import jakarta.persistence.Version
import java.time.Instant
import java.util.UUID

enum class NoteType { TEXT, LIST }
enum class UserRole { ADMIN, USER }
enum class AuthTokenPurpose { SESSION, RECOVERY }

@Entity
@Table(name = "users")
class UserEntity(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    var id: Long? = null,
    @Column(nullable = false, unique = true)
    var email: String = "",
    @Column(name = "password_hash", nullable = false)
    var passwordHash: String = "",
    @Column(nullable = false)
    var enabled: Boolean = true,
    @Column(name = "deleted_at")
    var deletedAt: Instant? = null,
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    var role: UserRole = UserRole.USER,
    @Column(name = "recovery_pending", nullable = false)
    var recoveryPending: Boolean = false,
    @Column(name = "email_verified_at")
    var emailVerifiedAt: Instant? = null,
    @Column(name = "kdf_salt", columnDefinition = "bytea")
    var kdfSalt: ByteArray? = null,
    @Column(name = "kdf_params", columnDefinition = "text")
    var kdfParams: String? = null,
    @Column(name = "wrapped_vault_key", columnDefinition = "bytea")
    var wrappedVaultKey: ByteArray? = null,
    @Column(name = "wrapped_vault_key_recovery", columnDefinition = "bytea")
    var wrappedVaultKeyRecovery: ByteArray? = null,
    @Column(name = "vault_initialized_at")
    var vaultInitializedAt: Instant? = null,
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
) {
    /** True once a vault has been set up (recovery wrap present). Password wrap may be cleared by admin reset. */
    val vaultInitialized: Boolean
        get() = vaultInitializedAt != null &&
            kdfSalt != null &&
            wrappedVaultKeyRecovery != null

    val emailVerified: Boolean
        get() = emailVerifiedAt != null
}

@Entity
@Table(name = "email_verification_tokens")
class EmailVerificationTokenEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "user_id", nullable = false)
    var userId: Long = 0,
    @Column(name = "token_hash", nullable = false, unique = true, length = 64)
    var tokenHash: String = "",
    @Column(name = "expires_at", nullable = false)
    var expiresAt: Instant = Instant.now(),
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "consumed_at")
    var consumedAt: Instant? = null,
)

@Entity
@Table(name = "auth_tokens")
class AuthTokenEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "user_id", nullable = false)
    var userId: Long = 0,
    @Column(name = "token_hash", nullable = false, unique = true, length = 64)
    var tokenHash: String = "",
    @Column(name = "expires_at", nullable = false)
    var expiresAt: Instant = Instant.now(),
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "revoked_at")
    var revokedAt: Instant? = null,
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    var purpose: AuthTokenPurpose = AuthTokenPurpose.SESSION,
)

@Entity
@Table(name = "notes")
class NoteEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "user_id", nullable = false)
    var userId: Long = 0,
    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    var type: NoteType = NoteType.TEXT,
    @Column(name = "background_color", nullable = false, length = 32)
    var backgroundColor: String = "default",
    @Column(name = "is_archived", nullable = false)
    var archived: Boolean = false,
    @Column(name = "is_pinned", nullable = false)
    var pinned: Boolean = false,
    @Column(name = "wrapped_note_key", nullable = false, columnDefinition = "bytea")
    var wrappedNoteKey: ByteArray = ByteArray(0),
    @Column(nullable = false, columnDefinition = "bytea")
    var ciphertext: ByteArray = ByteArray(0),
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
    @Column(name = "updated_at", nullable = false)
    var updatedAt: Instant = Instant.now(),
    @Version
    @Column(nullable = false)
    var version: Long = 0,
    @Column(name = "deleted_at")
    var deletedAt: Instant? = null,
)

@Entity
@Table(name = "labels")
class LabelEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "user_id", nullable = false)
    var userId: Long = 0,
    @Column(nullable = false, columnDefinition = "bytea")
    var ciphertext: ByteArray = ByteArray(0),
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
)

@Entity
@Table(name = "note_labels")
class NoteLabelEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "note_id", nullable = false)
    var noteId: UUID = UUID.randomUUID(),
    @Column(name = "label_id", nullable = false)
    var labelId: UUID = UUID.randomUUID(),
)

@Entity
@Table(name = "attachments")
class AttachmentEntity(
    @Id
    var id: UUID = UUID.randomUUID(),
    @Column(name = "note_id", nullable = false)
    var noteId: UUID = UUID.randomUUID(),
    @Column(name = "storage_path", nullable = false, unique = true)
    var storagePath: String = "",
    @Column(name = "meta_ciphertext", nullable = false, columnDefinition = "bytea")
    var metaCiphertext: ByteArray = ByteArray(0),
    @Column(name = "size_bytes", nullable = false)
    var sizeBytes: Long = 0,
    @Column(name = "created_at", nullable = false)
    var createdAt: Instant = Instant.now(),
)
