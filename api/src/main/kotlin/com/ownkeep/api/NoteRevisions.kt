package com.ownkeep.api

import com.fasterxml.jackson.annotation.JsonAnySetter
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.ownkeep.api.storage.AttachmentBlobStore
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import org.slf4j.LoggerFactory
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.data.domain.PageRequest
import org.springframework.format.annotation.DateTimeFormat
import org.springframework.http.HttpStatus
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class CreateNoteRevisionRequest(
    @field:NotNull
    val id: UUID,
    @field:NotNull
    val sourceVersion: Long,
    @field:NotBlank
    val wrappedNoteKey: String,
    @field:NotBlank
    val snapshotCiphertext: String,
)

data class NoteRevisionSummaryResponse(
    val id: UUID,
    val createdAt: Instant,
    val sourceVersion: Long,
    val labelCiphertext: String?,
    val origin: String = NoteRevisionOrigin.NORMAL.name,
)

data class CreateNoteRevisionResponse(
    val created: Boolean,
    val revision: NoteRevisionSummaryResponse,
)

data class NoteRevisionPageResponse(
    val items: List<NoteRevisionSummaryResponse>,
    val nextCreatedAt: Instant?,
    val nextAfterId: UUID?,
    val hasMore: Boolean,
)

data class NoteRevisionDetailResponse(
    val id: UUID,
    val createdAt: Instant,
    val sourceVersion: Long,
    val labelCiphertext: String?,
    val origin: String = NoteRevisionOrigin.NORMAL.name,
    val wrappedNoteKey: String,
    val snapshotCiphertext: String,
)

@JsonIgnoreProperties(ignoreUnknown = true)
class UpdateNoteRevisionRequest(
    val labelCiphertext: String? = null,
) {
    @JsonAnySetter
    fun rejectUnknown(name: String, @Suppress("UNUSED_PARAMETER") value: Any?) {
        throw IllegalArgumentException("Unknown property: $name")
    }
}

data class RestoreUndoRevisionRequest(
    @field:NotNull
    val id: UUID,
    @field:NotNull
    val sourceVersion: Long,
    @field:NotBlank
    val wrappedNoteKey: String,
    @field:NotBlank
    val snapshotCiphertext: String,
)

data class RestoreNoteRevisionRequest(
    @field:NotNull
    val expectedVersion: Long,
    @field:Valid
    @field:NotNull
    val undoRevision: RestoreUndoRevisionRequest,
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
    @field:Size(max = 200)
    val attachmentIds: List<UUID> = emptyList(),
)

data class RestoreNoteRevisionResponse(
    val note: NoteResponse,
    val unavailableAttachmentIds: List<UUID>,
)

@Service
class NoteRevisionService(
    private val noteRepository: NoteRepository,
    private val noteRevisionRepository: NoteRevisionRepository,
    private val labelRepository: LabelRepository,
    private val noteLabelRepository: NoteLabelRepository,
    private val attachmentRepository: AttachmentRepository,
    private val attachmentBlobStore: AttachmentBlobStore,
    private val properties: OwnKeepProperties,
) {
    private val clock: Clock = Clock.systemUTC()
    fun retentionCutoff(): Instant = clock.instant().minus(properties.noteRevisionRetention)

    @Transactional
    fun create(userId: Long, noteId: UUID, request: CreateNoteRevisionRequest): CreateNoteRevisionResponse {
        val note = noteRepository.findOwnedForUpdate(noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        if (request.sourceVersion != note.version) {
            throw ApiException(HttpStatus.CONFLICT, "version_conflict", "The note has changed since it was loaded")
        }
        val existing = noteRevisionRepository.findByNoteIdAndSourceNoteVersionAndOrigin(
            noteId,
            request.sourceVersion,
            NoteRevisionOrigin.NORMAL,
        )
        if (existing != null) {
            return CreateNoteRevisionResponse(created = false, revision = existing.toSummary())
        }
        val wrappedKey = CryptoSupport.decodeRequired(request.wrappedNoteKey, "wrappedNoteKey", minBytes = 28, maxBytes = 512)
        val snapshot = CryptoSupport.decodeRequired(
            request.snapshotCiphertext,
            "snapshotCiphertext",
            minBytes = 28,
            maxBytes = 3_145_728,
        )
        if (noteRevisionRepository.existsById(request.id)) {
            throw ApiException(HttpStatus.CONFLICT, "revision_exists", "A revision with this id already exists")
        }
        val saved = try {
            noteRevisionRepository.saveAndFlush(
                NoteRevisionEntity(
                    id = request.id,
                    noteId = noteId,
                    sourceNoteVersion = request.sourceVersion,
                    origin = NoteRevisionOrigin.NORMAL,
                    wrappedNoteKey = wrappedKey,
                    snapshotCiphertext = snapshot,
                    createdAt = clock.instant(),
                ),
            )
        } catch (_: DataIntegrityViolationException) {
            val raced = noteRevisionRepository.findByNoteIdAndSourceNoteVersionAndOrigin(
                noteId,
                request.sourceVersion,
                NoteRevisionOrigin.NORMAL,
            )
                ?: throw ApiException(HttpStatus.CONFLICT, "revision_exists", "A revision with this id already exists")
            return CreateNoteRevisionResponse(created = false, revision = raced.toSummary())
        }
        return CreateNoteRevisionResponse(created = true, revision = saved.toSummary())
    }

    @Transactional(readOnly = true)
    fun list(
        userId: Long,
        noteId: UUID,
        createdBefore: Instant?,
        afterId: UUID?,
        requestedLimit: Int,
    ): NoteRevisionPageResponse {
        requireOwnedNote(userId, noteId)
        if ((createdBefore == null) != (afterId == null)) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor", "created_before and after_id must be provided together")
        }
        val limit = requestedLimit.coerceIn(1, 100)
        val hasCursor = createdBefore != null && afterId != null
        val rows = noteRevisionRepository.findPage(
            noteId = noteId,
            cutoff = retentionCutoff(),
            hasCursor = hasCursor,
            createdBefore = createdBefore ?: Instant.EPOCH,
            afterId = afterId ?: UUID(0, 0),
            pageable = PageRequest.of(0, limit + 1),
        )
        val page = rows.take(limit)
        val last = page.lastOrNull()
        return NoteRevisionPageResponse(
            items = page.map { it.toSummary() },
            nextCreatedAt = last?.createdAt,
            nextAfterId = last?.id,
            hasMore = rows.size > limit,
        )
    }

    @Transactional(readOnly = true)
    fun get(userId: Long, noteId: UUID, revisionId: UUID): NoteRevisionDetailResponse {
        requireOwnedNote(userId, noteId)
        val revision = findUnexpiredRevision(noteId, revisionId)
        return NoteRevisionDetailResponse(
            id = revision.id,
            createdAt = revision.createdAt,
            sourceVersion = revision.sourceNoteVersion,
            labelCiphertext = revision.labelCiphertext?.let(CryptoSupport::encode),
            origin = revision.origin.name,
            wrappedNoteKey = CryptoSupport.encode(revision.wrappedNoteKey),
            snapshotCiphertext = CryptoSupport.encode(revision.snapshotCiphertext),
        )
    }

    @Transactional
    fun updateLabel(userId: Long, noteId: UUID, revisionId: UUID, request: UpdateNoteRevisionRequest): NoteRevisionSummaryResponse {
        requireOwnedNote(userId, noteId)
        val revision = findUnexpiredRevision(noteId, revisionId)
        revision.labelCiphertext = CryptoSupport.decodeOptional(
            request.labelCiphertext,
            "labelCiphertext",
            minBytes = 28,
            maxBytes = 1024,
        )
        return noteRevisionRepository.save(revision).toSummary()
    }

    @Transactional
    fun restore(userId: Long, noteId: UUID, revisionId: UUID, request: RestoreNoteRevisionRequest): RestoreNoteRevisionResponse {
        val note = noteRepository.findOwnedForUpdate(noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        if (request.expectedVersion != note.version) {
            throw ApiException(HttpStatus.CONFLICT, "version_conflict", "The note has changed since it was loaded")
        }
        findUnexpiredRevision(noteId, revisionId)
        if (request.undoRevision.sourceVersion != note.version) {
            throw ApiException(
                HttpStatus.BAD_REQUEST,
                "invalid_undo_revision",
                "undoRevision.sourceVersion must match the current note version",
            )
        }

        val existingUndo = noteRevisionRepository.findByNoteIdAndSourceNoteVersionAndOrigin(
            noteId,
            note.version,
            NoteRevisionOrigin.NORMAL,
        )
        if (existingUndo == null) {
            if (noteRevisionRepository.existsById(request.undoRevision.id)) {
                throw ApiException(HttpStatus.CONFLICT, "revision_exists", "A revision with this id already exists")
            }
            noteRevisionRepository.save(
                NoteRevisionEntity(
                    id = request.undoRevision.id,
                    noteId = noteId,
                    sourceNoteVersion = request.undoRevision.sourceVersion,
                    origin = NoteRevisionOrigin.NORMAL,
                    wrappedNoteKey = CryptoSupport.decodeRequired(
                        request.undoRevision.wrappedNoteKey,
                        "undoRevision.wrappedNoteKey",
                        minBytes = 28,
                        maxBytes = 512,
                    ),
                    snapshotCiphertext = CryptoSupport.decodeRequired(
                        request.undoRevision.snapshotCiphertext,
                        "undoRevision.snapshotCiphertext",
                        minBytes = 28,
                        maxBytes = 3_145_728,
                    ),
                    createdAt = clock.instant(),
                ),
            )
        }

        val labelIds = validateLabelIds(userId, request.labelIds)
        val desiredAttachmentIds = request.attachmentIds.distinct()
        if (desiredAttachmentIds.size > 200) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_attachments", "Too many attachments")
        }
        val ownedAttachments = if (desiredAttachmentIds.isEmpty()) {
            emptyList()
        } else {
            desiredAttachmentIds.map { attachmentId ->
                attachmentRepository.findOwnedOnNote(attachmentId, noteId, userId)
                    ?: throw ApiException(
                        HttpStatus.BAD_REQUEST,
                        "invalid_attachments",
                        "One or more attachments were not found on this note",
                    )
            }
        }

        val now = clock.instant()
        val unavailable = mutableListOf<UUID>()
        val restoredIds = mutableSetOf<UUID>()
        for (attachment in ownedAttachments) {
            if (!attachmentBlobStore.exists(attachment.storagePath)) {
                unavailable += attachment.id
                continue
            }
            attachment.deletedAt = null
            attachmentRepository.save(attachment)
            restoredIds += attachment.id
        }

        val liveAttachments = attachmentRepository.findAllByNoteIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(noteId)
        for (attachment in liveAttachments) {
            if (attachment.id !in restoredIds) {
                attachment.deletedAt = now
                attachmentRepository.save(attachment)
            }
        }

        note.type = request.type
        note.backgroundColor = validateColor(request.backgroundColor)
        note.archived = request.archived
        note.pinned = request.pinned
        note.ciphertext = CryptoSupport.decodeRequired(request.ciphertext, "ciphertext", minBytes = 28, maxBytes = 2_000_000)
        note.wrappedNoteKey = CryptoSupport.decodeRequired(request.wrappedNoteKey, "wrappedNoteKey", minBytes = 28, maxBytes = 512)
        note.updatedAt = now
        note.clientUpdatedAt = now
        note.clientMutationId = null
        noteRepository.save(note)
        replaceLabels(note, labelIds)

        return RestoreNoteRevisionResponse(
            note = toNoteResponse(note),
            unavailableAttachmentIds = unavailable,
        )
    }

    @Transactional
    fun purgeExpired(): Int {
        val cutoff = retentionCutoff()
        val deletedRevisions = noteRevisionRepository.deleteAllCreatedBefore(cutoff)
        var deletedAttachments = 0
        while (true) {
            val batch = attachmentRepository.findSoftDeletedBefore(cutoff, PageRequest.of(0, 200))
            if (batch.isEmpty()) break
            val paths = batch.map { it.storagePath }
            attachmentRepository.deleteAll(batch)
            attachmentBlobStore.deleteAfterCommit(paths)
            deletedAttachments += batch.size
            if (batch.size < 200) break
        }
        return deletedRevisions + deletedAttachments
    }

    private fun requireOwnedNote(userId: Long, noteId: UUID): NoteEntity =
        noteRepository.findByIdAndUserIdAndDeletedAtIsNull(noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")

    private fun findUnexpiredRevision(noteId: UUID, revisionId: UUID): NoteRevisionEntity {
        val revision = noteRevisionRepository.findByIdAndNoteId(revisionId, noteId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "revision_not_found", "Revision not found")
        if (revision.createdAt.isBefore(retentionCutoff())) {
            throw ApiException(HttpStatus.NOT_FOUND, "revision_not_found", "Revision not found")
        }
        return revision
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

    private fun replaceLabels(note: NoteEntity, labelIds: List<UUID>) {
        noteLabelRepository.deleteAllByNoteId(note.id)
        if (labelIds.isEmpty()) return
        noteLabelRepository.saveAll(labelIds.map { NoteLabelEntity(noteId = note.id, labelId = it) })
    }

    private fun validateColor(value: String): String {
        if (!Regex("^[#a-zA-Z0-9_-]{1,32}$").matches(value)) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_color", "Invalid background color")
        }
        return value
    }

    private fun toNoteResponse(note: NoteEntity): NoteResponse {
        val attachments = attachmentRepository.findAllByNoteIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(note.id).map {
            AttachmentResponse(
                id = it.id,
                metaCiphertext = CryptoSupport.encode(it.metaCiphertext),
                sizeBytes = it.sizeBytes,
                createdAt = it.createdAt,
                url = "/attachments/${it.id}",
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
            labelIds = noteLabelRepository.findLabelIdsByNoteId(note.id),
            attachments = attachments,
            createdAt = note.createdAt,
            updatedAt = note.updatedAt,
            clientUpdatedAt = note.clientUpdatedAt,
            clientMutationId = note.clientMutationId,
            version = note.version,
        )
    }
}

@Component
class NoteRevisionPurgeScheduler(
    private val noteRevisionService: NoteRevisionService,
    private val properties: OwnKeepProperties,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(cron = "0 30 3 * * *")
    fun purgeExpiredRevisionsAndAttachments() {
        val retention = properties.noteRevisionRetention
        if (retention.isNegative || retention.isZero) return
        val purged = noteRevisionService.purgeExpired()
        if (purged > 0) {
            log.info("Purged {} expired note revision/attachment record(s)", purged)
        }
    }
}

@RestController
@RequestMapping("/notes/{noteId}/revisions")
class NoteRevisionController(private val noteRevisionService: NoteRevisionService) {
    @PostMapping
    fun create(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @Valid @RequestBody request: CreateNoteRevisionRequest,
    ) = noteRevisionService.create(principal(authentication).userId, noteId, request)

    @GetMapping
    fun list(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @RequestParam(name = "created_before", required = false)
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        createdBefore: Instant?,
        @RequestParam(name = "after_id", required = false) afterId: UUID?,
        @RequestParam(defaultValue = "50") limit: Int,
    ) = noteRevisionService.list(principal(authentication).userId, noteId, createdBefore, afterId, limit)

    @GetMapping("/{revisionId}")
    fun get(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @PathVariable revisionId: UUID,
    ) = noteRevisionService.get(principal(authentication).userId, noteId, revisionId)

    @PatchMapping("/{revisionId}")
    fun updateLabel(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @PathVariable revisionId: UUID,
        @Valid @RequestBody request: UpdateNoteRevisionRequest,
    ) = noteRevisionService.updateLabel(principal(authentication).userId, noteId, revisionId, request)

    @PostMapping("/{revisionId}/restore")
    fun restore(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @PathVariable revisionId: UUID,
        @Valid @RequestBody request: RestoreNoteRevisionRequest,
    ) = noteRevisionService.restore(principal(authentication).userId, noteId, revisionId, request)
}
