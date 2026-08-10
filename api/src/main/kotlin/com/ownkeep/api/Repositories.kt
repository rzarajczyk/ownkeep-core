package com.ownkeep.api

import jakarta.persistence.LockModeType
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Lock
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.Instant
import java.util.UUID

interface UserRepository : JpaRepository<UserEntity, Long> {
    fun findByEmail(email: String): UserEntity?
    fun findAllByEmailIn(emails: Collection<String>): List<UserEntity>

    @Query(
        """
            select u from UserEntity u
            order by u.enabled desc, lower(u.email) asc, u.email asc
        """,
    )
    fun findAllForAdministration(): List<UserEntity>

    fun existsByRoleAndEnabledTrue(role: UserRole): Boolean

    fun existsByRoleAndEnabledTrueAndIdNot(role: UserRole, id: Long): Boolean

    fun findByEnabledFalseAndDeletedAtLessThanEqual(cutoff: Instant): List<UserEntity>

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from UserEntity u where u.id = :id")
    fun findForUpdateById(@Param("id") id: Long): UserEntity?
}

interface EmailVerificationTokenRepository : JpaRepository<EmailVerificationTokenEntity, UUID> {
    fun findByTokenHash(tokenHash: String): EmailVerificationTokenEntity?

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query(
        """
            select t from EmailVerificationTokenEntity t
            where t.tokenHash = :tokenHash
              and t.consumedAt is null
              and t.expiresAt > :now
        """,
    )
    fun findValidForUpdate(
        @Param("tokenHash") tokenHash: String,
        @Param("now") now: Instant,
    ): EmailVerificationTokenEntity?

    @Modifying
    @Query(
        """
            update EmailVerificationTokenEntity t
            set t.consumedAt = :now
            where t.userId = :userId
              and t.consumedAt is null
        """,
    )
    fun consumeAllForUser(@Param("userId") userId: Long, @Param("now") now: Instant): Int
}

interface AuthTokenRepository : JpaRepository<AuthTokenEntity, UUID> {
    fun findByTokenHashAndPurposeAndRevokedAtIsNullAndExpiresAtAfter(
        tokenHash: String,
        purpose: AuthTokenPurpose,
        now: Instant,
    ): AuthTokenEntity?

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query(
        """
            select t from AuthTokenEntity t
            where t.tokenHash = :tokenHash
              and t.purpose = :purpose
              and t.revokedAt is null
              and t.expiresAt > :now
        """,
    )
    fun findValidForUpdate(
        @Param("tokenHash") tokenHash: String,
        @Param("purpose") purpose: AuthTokenPurpose,
        @Param("now") now: Instant,
    ): AuthTokenEntity?

    @Modifying
    @Query("update AuthTokenEntity t set t.revokedAt = :now where t.tokenHash = :hash and t.revokedAt is null")
    fun revoke(@Param("hash") hash: String, @Param("now") now: Instant): Int

    @Modifying
    @Query("update AuthTokenEntity t set t.revokedAt = :now where t.userId = :userId and t.revokedAt is null")
    fun revokeAllForUser(@Param("userId") userId: Long, @Param("now") now: Instant): Int

    @Modifying
    @Query("delete from AuthTokenEntity t where t.expiresAt < :before or t.revokedAt < :before")
    fun deleteExpiredAndRevokedBefore(@Param("before") before: Instant): Int
}

interface NoteRepository : JpaRepository<NoteEntity, UUID> {
    fun findByIdAndUserIdAndDeletedAtIsNull(id: UUID, userId: Long): NoteEntity?

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query(
        """
            select n from NoteEntity n
            where n.id = :id and n.userId = :userId and n.deletedAt is null
        """,
    )
    fun findOwnedForUpdate(@Param("id") id: UUID, @Param("userId") userId: Long): NoteEntity?

    @Query(
        value = """
            select * from notes n
            where n.user_id = :userId
              and (n.updated_at > :updatedAfter or
                   (n.updated_at = :updatedAfter and n.id > :afterId))
              and (n.deleted_at is not null or :archived is null or n.is_archived = :archived)
            order by n.updated_at asc, n.id asc
        """,
        nativeQuery = true,
    )
    fun findSyncPage(
        @Param("userId") userId: Long,
        @Param("updatedAfter") updatedAfter: Instant,
        @Param("afterId") afterId: UUID,
        @Param("archived") archived: Boolean?,
        pageable: Pageable,
    ): List<NoteEntity>
}

interface LabelRepository : JpaRepository<LabelEntity, UUID> {
    fun findAllByUserIdOrderByCreatedAtAscIdAsc(userId: Long): List<LabelEntity>
    fun findByIdAndUserId(id: UUID, userId: Long): LabelEntity?
    fun findAllByUserIdAndIdIn(userId: Long, ids: Collection<UUID>): List<LabelEntity>
}

interface NoteLabelRepository : JpaRepository<NoteLabelEntity, UUID> {
    @Query(
        """
            select nl.labelId from NoteLabelEntity nl
            where nl.noteId = :noteId
            order by nl.labelId
        """,
    )
    fun findLabelIdsByNoteId(@Param("noteId") noteId: UUID): List<UUID>

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from NoteLabelEntity nl where nl.noteId = :noteId")
    fun deleteAllByNoteId(@Param("noteId") noteId: UUID): Int

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from NoteLabelEntity nl where nl.labelId = :labelId")
    fun deleteAllByLabelId(@Param("labelId") labelId: UUID): Int
}

interface AttachmentRepository : JpaRepository<AttachmentEntity, UUID> {
    fun findAllByNoteIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(noteId: UUID): List<AttachmentEntity>

    fun findAllByNoteIdOrderByCreatedAtAscIdAsc(noteId: UUID): List<AttachmentEntity>

    @Query(
        """
            select a from AttachmentEntity a, NoteEntity n
            where a.id = :id and a.noteId = n.id
              and n.userId = :userId and n.deletedAt is null
              and a.deletedAt is null
        """,
    )
    fun findOwnedActive(@Param("id") id: UUID, @Param("userId") userId: Long): AttachmentEntity?

    @Query(
        """
            select a from AttachmentEntity a, NoteEntity n
            where a.id = :id and a.noteId = :noteId and a.noteId = n.id
              and n.userId = :userId and n.deletedAt is null
        """,
    )
    fun findOwnedOnNote(
        @Param("id") id: UUID,
        @Param("noteId") noteId: UUID,
        @Param("userId") userId: Long,
    ): AttachmentEntity?

    @Query(
        """
            select coalesce(sum(a.sizeBytes), 0) from AttachmentEntity a, NoteEntity n
            where a.noteId = n.id and n.userId = :userId
        """,
    )
    fun totalBytesForUser(@Param("userId") userId: Long): Long

    @Query(
        """
            select a.storagePath from AttachmentEntity a, NoteEntity n
            where a.noteId = n.id and n.userId = :userId
        """,
    )
    fun findStoragePathsByUserId(@Param("userId") userId: Long): List<String>

    @Query(
        """
            select a from AttachmentEntity a
            where a.deletedAt is not null and a.deletedAt < :cutoff
        """,
    )
    fun findSoftDeletedBefore(@Param("cutoff") cutoff: Instant, pageable: Pageable): List<AttachmentEntity>

    @Modifying
    fun deleteAllByNoteId(noteId: UUID): Int
}

interface NoteRevisionRepository : JpaRepository<NoteRevisionEntity, UUID> {
    fun findByNoteIdAndSourceNoteVersion(noteId: UUID, sourceNoteVersion: Long): NoteRevisionEntity?

    fun findByIdAndNoteId(id: UUID, noteId: UUID): NoteRevisionEntity?

    @Query(
        """
            select r from NoteRevisionEntity r
            where r.noteId = :noteId
              and r.createdAt >= :cutoff
              and (
                :hasCursor = false
                or r.createdAt < :createdBefore
                or (r.createdAt = :createdBefore and r.id < :afterId)
              )
            order by r.createdAt desc, r.id desc
        """,
    )
    fun findPage(
        @Param("noteId") noteId: UUID,
        @Param("cutoff") cutoff: Instant,
        @Param("hasCursor") hasCursor: Boolean,
        @Param("createdBefore") createdBefore: Instant,
        @Param("afterId") afterId: UUID,
        pageable: Pageable,
    ): List<NoteRevisionEntity>

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from NoteRevisionEntity r where r.noteId = :noteId")
    fun deleteAllByNoteId(@Param("noteId") noteId: UUID): Int

    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("delete from NoteRevisionEntity r where r.createdAt < :cutoff")
    fun deleteAllCreatedBefore(@Param("cutoff") cutoff: Instant): Int
}
