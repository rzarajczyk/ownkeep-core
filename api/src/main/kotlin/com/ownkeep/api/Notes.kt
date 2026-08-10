package com.ownkeep.api

import com.ownkeep.api.storage.AttachmentBlobStore
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
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
)

data class AttachmentResponse(
    val id: UUID,
    val metaCiphertext: String,
    val sizeBytes: Long,
    val createdAt: Instant,
    val url: String,
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
    val version: Long,
)

data class NotesSyncResponse(
    val items: List<NoteResponse>,
    val deletedIds: List<UUID>,
    val nextUpdatedAfter: Instant,
    val nextAfterId: UUID,
    val hasMore: Boolean,
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
        note.updatedAt = Instant.now()
        noteRepository.save(note)
        request.labelIds?.let { replaceLabels(note, validateLabelIds(userId, it)) }
        return toResponse(note)
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
        val last = page.lastOrNull()
        return NotesSyncResponse(
            items = page.filter { it.deletedAt == null }.map(::toResponse),
            deletedIds = page.filter { it.deletedAt != null }.map { it.id },
            nextUpdatedAfter = last?.updatedAt ?: cursorTime,
            nextAfterId = last?.id ?: cursorId,
            hasMore = rows.size > limit,
        )
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

    private fun toResponse(note: NoteEntity): NoteResponse {
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
            version = note.version,
        )
    }
}

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
