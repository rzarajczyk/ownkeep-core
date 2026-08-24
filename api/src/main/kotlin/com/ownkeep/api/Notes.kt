package com.ownkeep.api

import com.ownkeep.api.storage.AttachmentBlobStore
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.data.domain.PageRequest
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Duration
import java.time.Instant
import java.util.UUID

data class CreateNoteRequest(
    /** Client-generated id so ciphertext AAD can bind to the note id before upload. */
    val id: UUID? = null,
    val type: NoteType,
    @field:Size(max = 32)
    val backgroundColor: String = "default",
    val archived: Boolean = false,
    val pinned: Boolean = false,
    @field:NotBlank
    val wrappedNoteKey: String,
    @field:NotBlank
    val ciphertext: String,
    @field:Size(max = 100)
    val labelIds: List<UUID> = emptyList(),
    val clientUpdatedAt: Instant? = null,
    @field:Size(max = 36)
    val clientMutationId: String? = null,
)

data class UpdateNoteRequest(
    val type: NoteType? = null,
    @field:Size(max = 32)
    val backgroundColor: String? = null,
    val archived: Boolean? = null,
    val pinned: Boolean? = null,
    val wrappedNoteKey: String? = null,
    val ciphertext: String? = null,
    @field:Size(max = 100)
    val labelIds: List<UUID>? = null,
    val version: Long? = null,
    val clientUpdatedAt: Instant? = null,
    @field:Size(max = 36)
    val clientMutationId: String? = null,
)

data class AttachmentResponse(
    val id: UUID,
    val metaCiphertext: String,
    val sizeBytes: Long,
    val createdAt: Instant,
    val url: String,
    val thumbnailCiphertext: String? = null,
)

data class NoteResponse(
    val id: UUID,
    val type: NoteType,
    val backgroundColor: String,
    val archived: Boolean,
    val pinned: Boolean,
    val wrappedNoteKey: String,
    val ciphertext: String,
    val labelIds: List<UUID>,
    val attachments: List<AttachmentResponse>,
    val createdAt: Instant,
    val updatedAt: Instant,
    val clientUpdatedAt: Instant,
    val clientMutationId: String?,
    val version: Long,
)

data class NotesSyncResponse(
    val items: List<NoteResponse>,
    val deletedIds: List<UUID>,
    val nextUpdatedAfter: Instant,
    val nextAfterId: UUID,
    val hasMore: Boolean,
)

data class ConflictResolveRequest(
    @field:NotNull
    val version: Long,
    @field:NotNull
    val localRevisionId: UUID,
    @field:NotNull
    val remoteRevisionId: UUID,
    val type: NoteType,
    @field:Size(max = 32)
    val backgroundColor: String = "default",
    val archived: Boolean = false,
    val pinned: Boolean = false,
    @field:NotBlank
    val wrappedNoteKey: String,
    @field:NotBlank
    val ciphertext: String,
    @field:NotBlank
    val localSnapshotCiphertext: String,
    @field:NotBlank
    val remoteSnapshotCiphertext: String,
    @field:Size(max = 100)
    val labelIds: List<UUID> = emptyList(),
    @field:NotNull
    val clientUpdatedAt: Instant,
    @field:NotBlank
    @field:Size(max = 36)
    val clientMutationId: String,
)

data class ConflictResolveResponse(
    val note: NoteResponse,
    val winner: String,
    val localRevision: NoteRevisionSummaryResponse?,
    val remoteRevision: NoteRevisionSummaryResponse?,
)

@Service
class NoteService(
    private val noteRepository: NoteRepository,
    private val labelRepository: LabelRepository,
    private val noteLabelRepository: NoteLabelRepository,
    private val attachmentRepository: AttachmentRepository,
    private val noteRevisionRepository: NoteRevisionRepository,
    private val attachmentBlobStore: AttachmentBlobStore,
    private val properties: OwnKeepProperties,
) {
    @Transactional
    fun create(userId: Long, request: CreateNoteRequest): NoteResponse {
        val wrappedKey = CryptoSupport.decodeRequired(request.wrappedNoteKey, "wrappedNoteKey", minBytes = 28, maxBytes = 512)
        val ciphertext = CryptoSupport.decodeRequired(request.ciphertext, "ciphertext", minBytes = 28, maxBytes = 2_000_000)
        val labelIds = validateLabelIds(userId, request.labelIds)
        val now = Instant.now()
        val noteId = request.id ?: UUID.randomUUID()
        if (request.id != null && noteRepository.existsById(noteId)) {
            throw ApiException(HttpStatus.CONFLICT, "note_exists", "A note with this id already exists")
        }
        val clientUpdatedAt = normalizeClientUpdatedAt(request.clientUpdatedAt, now)
        val note = noteRepository.save(
            NoteEntity(
                id = noteId,
                userId = userId,
                type = request.type,
                backgroundColor = validateColor(request.backgroundColor),
                archived = request.archived,
                pinned = request.pinned,
                wrappedNoteKey = wrappedKey,
                ciphertext = ciphertext,
                createdAt = now,
                updatedAt = now,
                clientUpdatedAt = clientUpdatedAt,
                clientMutationId = normalizeMutationId(request.clientMutationId),
            ),
        )
        replaceLabels(note, labelIds)
        return toResponse(note)
    }

    @Transactional(readOnly = true)
    fun get(userId: Long, id: UUID): NoteResponse = toResponse(findOwned(userId, id))

    @Transactional
    fun update(userId: Long, id: UUID, request: UpdateNoteRequest): NoteResponse {
        val note = findOwned(userId, id)
        if (request.version != null && request.version != note.version) {
            throw ApiException(HttpStatus.CONFLICT, "version_conflict", "The note has changed since it was loaded")
        }
        if ((request.ciphertext == null) != (request.wrappedNoteKey == null)) {
            throw ApiException(
                HttpStatus.BAD_REQUEST,
                "invalid_note",
                "ciphertext and wrappedNoteKey must be provided together",
            )
        }

        request.type?.let { note.type = it }
        request.backgroundColor?.let { note.backgroundColor = validateColor(it) }
        request.archived?.let { note.archived = it }
        request.pinned?.let { note.pinned = it }
        request.ciphertext?.let {
            note.ciphertext = CryptoSupport.decodeRequired(it, "ciphertext", minBytes = 28, maxBytes = 2_000_000)
            note.wrappedNoteKey = CryptoSupport.decodeRequired(
                requireNotNull(request.wrappedNoteKey),
                "wrappedNoteKey",
                minBytes = 28,
                maxBytes = 512,
            )
        }
        val now = Instant.now()
        note.updatedAt = now
        if (request.clientUpdatedAt != null || request.clientMutationId != null) {
            note.clientUpdatedAt = normalizeClientUpdatedAt(request.clientUpdatedAt, now)
            note.clientMutationId = normalizeMutationId(request.clientMutationId) ?: note.clientMutationId
        } else {
            note.clientUpdatedAt = now
        }
        noteRepository.save(note)
        request.labelIds?.let { replaceLabels(note, validateLabelIds(userId, it)) }
        return toResponse(note)
    }

    @Transactional
    fun conflictResolve(userId: Long, id: UUID, request: ConflictResolveRequest): ConflictResolveResponse {
        val note = noteRepository.findOwnedForUpdate(id, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        val now = Instant.now()
        val localClientUpdatedAt = normalizeClientUpdatedAt(request.clientUpdatedAt, now)
        val localMutationId = requireNotNull(normalizeMutationId(request.clientMutationId)) {
            "clientMutationId is required"
        }
        val localWrapped = CryptoSupport.decodeRequired(request.wrappedNoteKey, "wrappedNoteKey", minBytes = 28, maxBytes = 512)
        val localCipher = CryptoSupport.decodeRequired(request.ciphertext, "ciphertext", minBytes = 28, maxBytes = 2_000_000)
        val labelIds = validateLabelIds(userId, request.labelIds)

        if (request.version == note.version) {
            note.type = request.type
            note.backgroundColor = validateColor(request.backgroundColor)
            note.archived = request.archived
            note.pinned = request.pinned
            note.wrappedNoteKey = localWrapped
            note.ciphertext = localCipher
            note.updatedAt = now
            note.clientUpdatedAt = localClientUpdatedAt
            note.clientMutationId = localMutationId
            noteRepository.save(note)
            replaceLabels(note, labelIds)
            return ConflictResolveResponse(
                note = toResponse(note),
                winner = "local",
                localRevision = null,
                remoteRevision = null,
            )
        }

        val sourceVersion = note.version
        val localSnapshot = CryptoSupport.decodeRequired(
            request.localSnapshotCiphertext,
            "localSnapshotCiphertext",
            minBytes = 28,
            maxBytes = 3_145_728,
        )
        val remoteSnapshot = CryptoSupport.decodeRequired(
            request.remoteSnapshotCiphertext,
            "remoteSnapshotCiphertext",
            minBytes = 28,
            maxBytes = 3_145_728,
        )
        val remoteRevision = upsertConflictRevision(
            noteId = id,
            revisionId = request.remoteRevisionId,
            sourceVersion = sourceVersion,
            origin = NoteRevisionOrigin.CONFLICT_REMOTE,
            wrappedNoteKey = note.wrappedNoteKey,
            snapshotCiphertext = remoteSnapshot,
            now = now,
        )
        val localRevision = upsertConflictRevision(
            noteId = id,
            revisionId = request.localRevisionId,
            sourceVersion = sourceVersion,
            origin = NoteRevisionOrigin.CONFLICT_LOCAL,
            wrappedNoteKey = localWrapped,
            snapshotCiphertext = localSnapshot,
            now = now,
        )

        val localWins = localWins(
            localUpdatedAt = localClientUpdatedAt,
            localMutationId = localMutationId,
            remoteUpdatedAt = note.clientUpdatedAt,
            remoteMutationId = note.clientMutationId,
        )
        if (localWins) {
            note.type = request.type
            note.backgroundColor = validateColor(request.backgroundColor)
            note.archived = request.archived
            note.pinned = request.pinned
            note.wrappedNoteKey = localWrapped
            note.ciphertext = localCipher
            note.clientUpdatedAt = localClientUpdatedAt
            note.clientMutationId = localMutationId
            replaceLabels(note, labelIds)
        }
        note.updatedAt = now
        noteRepository.save(note)

        return ConflictResolveResponse(
            note = toResponse(note),
            winner = if (localWins) "local" else "remote",
            localRevision = localRevision.toSummary(),
            remoteRevision = remoteRevision.toSummary(),
        )
    }

    @Transactional
    fun delete(userId: Long, id: UUID) {
        val note = findOwned(userId, id)
        val now = Instant.now()
        note.deletedAt = now
        note.updatedAt = now
        noteRepository.save(note)
        noteLabelRepository.deleteAllByNoteId(id)
        noteRevisionRepository.deleteAllByNoteId(id)
        val attachments = attachmentRepository.findAllByNoteIdOrderByCreatedAtAscIdAsc(id)
        attachmentRepository.deleteAllByNoteId(id)
        attachmentBlobStore.deleteAfterCommit(attachments.map { it.storagePath })
    }

    @Transactional(readOnly = true)
    fun sync(
        userId: Long,
        updatedAfter: Instant?,
        afterId: UUID?,
        archived: Boolean?,
        requestedLimit: Int,
    ): NotesSyncResponse {
        if (updatedAfter == null && afterId != null) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor", "after_id requires updated_after")
        }
        val limit = requestedLimit.coerceIn(1, properties.maxSyncLimit.coerceAtLeast(1))
        val cursorTime = updatedAfter ?: Instant.EPOCH
        val cursorId = afterId ?: UUID(0, 0)
        val rows = noteRepository.findSyncPage(userId, cursorTime, cursorId, archived, PageRequest.of(0, limit + 1))
        val page = rows.take(limit)
        val activeNotes = page.filter { it.deletedAt == null }
        val activeIds = activeNotes.map { it.id }
        val attachmentsByNote = if (activeIds.isEmpty()) {
            emptyMap()
        } else {
            attachmentRepository.findAllActiveByNoteIdIn(activeIds).groupBy { it.noteId }
        }
        val labelIdsByNote = if (activeIds.isEmpty()) {
            emptyMap()
        } else {
            noteLabelRepository.findAllByNoteIdIn(activeIds)
                .groupBy({ it.noteId }, { it.labelId })
        }
        val last = page.lastOrNull()
        return NotesSyncResponse(
            items = activeNotes.map { note ->
                toResponse(
                    note,
                    attachmentsByNote[note.id].orEmpty(),
                    labelIdsByNote[note.id].orEmpty(),
                )
            },
            deletedIds = page.filter { it.deletedAt != null }.map { it.id },
            nextUpdatedAfter = last?.updatedAt ?: cursorTime,
            nextAfterId = last?.id ?: cursorId,
            hasMore = rows.size > limit,
        )
    }

    private fun upsertConflictRevision(
        noteId: UUID,
        revisionId: UUID,
        sourceVersion: Long,
        origin: NoteRevisionOrigin,
        wrappedNoteKey: ByteArray,
        snapshotCiphertext: ByteArray,
        now: Instant,
    ): NoteRevisionEntity {
        val existing = noteRevisionRepository.findByNoteIdAndSourceNoteVersionAndOrigin(noteId, sourceVersion, origin)
        if (existing != null) return existing
        if (noteRevisionRepository.existsById(revisionId)) {
            throw ApiException(HttpStatus.CONFLICT, "revision_exists", "A revision with this id already exists")
        }
        return try {
            noteRevisionRepository.saveAndFlush(
                NoteRevisionEntity(
                    id = revisionId,
                    noteId = noteId,
                    sourceNoteVersion = sourceVersion,
                    origin = origin,
                    wrappedNoteKey = wrappedNoteKey,
                    snapshotCiphertext = snapshotCiphertext,
                    createdAt = now,
                ),
            )
        } catch (_: DataIntegrityViolationException) {
            noteRevisionRepository.findByNoteIdAndSourceNoteVersionAndOrigin(noteId, sourceVersion, origin)
                ?: throw ApiException(HttpStatus.CONFLICT, "revision_exists", "A revision with this id already exists")
        }
    }

    private fun findOwned(userId: Long, id: UUID): NoteEntity =
        noteRepository.findByIdAndUserIdAndDeletedAtIsNull(id, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")

    private fun replaceLabels(note: NoteEntity, labelIds: List<UUID>) {
        noteLabelRepository.deleteAllByNoteId(note.id)
        if (labelIds.isEmpty()) return
        noteLabelRepository.saveAll(labelIds.map { NoteLabelEntity(noteId = note.id, labelId = it) })
    }

    private fun validateLabelIds(userId: Long, ids: List<UUID>): List<UUID> {
        if (ids.size > 100) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_labels", "A note cannot have more than 100 labels")
        }
        val distinct = ids.distinct()
        if (distinct.isEmpty()) return emptyList()
        val found = labelRepository.findAllByUserIdAndIdIn(userId, distinct)
        if (found.size != distinct.size) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_labels", "One or more labels were not found")
        }
        return distinct
    }

    private fun validateColor(value: String): String {
        if (!Regex("^[#a-zA-Z0-9_-]{1,32}$").matches(value)) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_color", "Invalid background color")
        }
        return value
    }

    private fun normalizeClientUpdatedAt(value: Instant?, fallback: Instant): Instant {
        val candidate = value ?: fallback
        val skewLimit = fallback.plus(Duration.ofMinutes(5))
        return if (candidate.isAfter(skewLimit)) skewLimit else candidate
    }

    private fun normalizeMutationId(value: String?): String? {
        if (value.isNullOrBlank()) return null
        val trimmed = value.trim()
        if (trimmed.length > 36) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_mutation_id", "clientMutationId is too long")
        }
        return trimmed
    }

    fun toResponse(note: NoteEntity): NoteResponse {
        val attachments = attachmentRepository.findAllByNoteIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(note.id)
        val labelIds = noteLabelRepository.findLabelIdsByNoteId(note.id)
        return toResponse(note, attachments, labelIds)
    }

    private fun toResponse(
        note: NoteEntity,
        attachments: List<AttachmentEntity>,
        labelIds: List<UUID>,
    ): NoteResponse {
        val attachmentResponses = attachments.map {
            AttachmentResponse(
                id = it.id,
                metaCiphertext = CryptoSupport.encode(it.metaCiphertext),
                sizeBytes = it.sizeBytes,
                createdAt = it.createdAt,
                url = "/attachments/${it.id}",
                thumbnailCiphertext = it.thumbnailCiphertext?.let(CryptoSupport::encode),
            )
        }
        return NoteResponse(
            id = note.id,
            type = note.type,
            backgroundColor = note.backgroundColor,
            archived = note.archived,
            pinned = note.pinned,
            wrappedNoteKey = CryptoSupport.encode(note.wrappedNoteKey),
            ciphertext = CryptoSupport.encode(note.ciphertext),
            labelIds = labelIds,
            attachments = attachmentResponses,
            createdAt = note.createdAt,
            updatedAt = note.updatedAt,
            clientUpdatedAt = note.clientUpdatedAt,
            clientMutationId = note.clientMutationId,
            version = note.version,
        )
    }
}

internal fun localWins(
    localUpdatedAt: Instant,
    localMutationId: String,
    remoteUpdatedAt: Instant,
    remoteMutationId: String?,
): Boolean {
    val cmp = localUpdatedAt.compareTo(remoteUpdatedAt)
    if (cmp != 0) return cmp > 0
    return localMutationId > (remoteMutationId ?: "")
}

internal fun NoteRevisionEntity.toSummary() = NoteRevisionSummaryResponse(
    id = id,
    createdAt = createdAt,
    sourceVersion = sourceNoteVersion,
    labelCiphertext = labelCiphertext?.let(CryptoSupport::encode),
    origin = origin.name,
)

@RestController
@RequestMapping("/notes")
class NoteController(private val noteService: NoteService) {
    @GetMapping
    fun sync(
        authentication: UsernamePasswordAuthenticationToken,
        @RequestParam(name = "updated_after", required = false)
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        updatedAfter: Instant?,
        @RequestParam(name = "after_id", required = false) afterId: UUID?,
        @RequestParam(required = false) archived: Boolean?,
        @RequestParam(defaultValue = "100") limit: Int,
    ) = noteService.sync(principal(authentication).userId, updatedAfter, afterId, archived, limit)

    @PostMapping
    fun create(
        authentication: UsernamePasswordAuthenticationToken,
        @Valid @RequestBody request: CreateNoteRequest,
    ) = noteService.create(principal(authentication).userId, request)

    @GetMapping("/{id}")
    fun get(authentication: UsernamePasswordAuthenticationToken, @PathVariable id: UUID) =
        noteService.get(principal(authentication).userId, id)

    @PatchMapping("/{id}")
    fun update(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: UUID,
        @Valid @RequestBody request: UpdateNoteRequest,
    ) = noteService.update(principal(authentication).userId, id, request)

    @PostMapping("/{id}/conflict-resolve")
    fun conflictResolve(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: UUID,
        @Valid @RequestBody request: ConflictResolveRequest,
    ) = noteService.conflictResolve(principal(authentication).userId, id, request)

    @DeleteMapping("/{id}")
    fun delete(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: UUID,
    ): ResponseEntity<Void> {
        noteService.delete(principal(authentication).userId, id)
        return ResponseEntity.noContent().build()
    }
}

fun principal(authentication: UsernamePasswordAuthenticationToken) =
    authentication.principal as OwnKeepPrincipal
