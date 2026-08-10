package com.ownkeep.api

import com.ownkeep.api.storage.AttachmentBlobStore
import com.ownkeep.api.storage.AttachmentSizeLimitExceededException
import org.springframework.core.io.InputStreamResource
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestPart
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.multipart.MultipartFile
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Instant
import java.util.UUID

data class StoredAttachment(
    val metadata: AttachmentEntity,
    val content: InputStream,
)

@Service
class AttachmentService(
    private val userRepository: UserRepository,
    private val noteRepository: NoteRepository,
    private val attachmentRepository: AttachmentRepository,
    private val blobStore: AttachmentBlobStore,
    private val properties: OwnKeepProperties,
) {
    private val clock: Clock = Clock.systemUTC()
    @Transactional
    fun upload(
        userId: Long,
        noteId: UUID,
        file: MultipartFile,
        metaCiphertextBase64: String,
        attachmentId: UUID? = null,
    ): AttachmentResponse {
        val user = userRepository.findForUpdateById(userId)
            ?: throw ApiException(HttpStatus.UNAUTHORIZED, "unauthorized", "User no longer exists")
        if (!user.enabled) throw ApiException(HttpStatus.UNAUTHORIZED, "unauthorized", "User is disabled")
        val note = noteRepository.findByIdAndUserIdAndDeletedAtIsNull(noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        val metaCiphertext = CryptoSupport.decodeRequired(
            metaCiphertextBase64,
            "metaCiphertext",
            minBytes = 28,
            maxBytes = 16_384,
        )
        val declaredSize = file.size
        val maxSize = properties.attachment.maxFileSize
        if (declaredSize > maxSize) {
            throw ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "File exceeds the configured size limit")
        }

        val used = attachmentRepository.totalBytesForUser(userId)
        val quota = properties.attachment.perUserQuota
        if (declaredSize > 0 && (declaredSize > quota || used > quota - declaredSize)) {
            throw ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "quota_exceeded", "Attachment storage quota exceeded")
        }

        val id = attachmentId ?: UUID.randomUUID()
        if (attachmentId != null && attachmentRepository.existsById(id)) {
            throw ApiException(HttpStatus.CONFLICT, "attachment_exists", "An attachment with this id already exists")
        }
        val relativePath = "$userId/$noteId/$id"
        var stored = false
        try {
            val actualSize = try {
                blobStore.store(relativePath, file.inputStream, maxSize)
            } catch (_: AttachmentSizeLimitExceededException) {
                throw ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "File exceeds the configured size limit")
            }
            stored = true
            if (actualSize > quota || used > quota - actualSize) {
                blobStore.delete(relativePath)
                stored = false
                throw ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "quota_exceeded", "Attachment storage quota exceeded")
            }
            blobStore.deleteOnRollback(relativePath)

            val metadata = attachmentRepository.save(
                AttachmentEntity(
                    id = id,
                    noteId = noteId,
                    storagePath = relativePath,
                    metaCiphertext = metaCiphertext,
                    sizeBytes = actualSize,
                    createdAt = clock.instant(),
                ),
            )
            note.updatedAt = clock.instant()
            noteRepository.save(note)
            return metadata.toResponse()
        } catch (ex: Exception) {
            if (stored) {
                try {
                    blobStore.delete(relativePath)
                } catch (_: Exception) {
                    // best-effort cleanup; deleteOnRollback may also run
                }
            }
            throw ex
        }
    }

    @Transactional(readOnly = true)
    fun open(userId: Long, id: UUID): StoredAttachment {
        val metadata = attachmentRepository.findOwnedActive(id, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "attachment_not_found", "Attachment not found")
        if (!blobStore.exists(metadata.storagePath)) {
            throw ApiException(HttpStatus.NOT_FOUND, "attachment_bytes_missing", "Attachment bytes are unavailable")
        }
        return StoredAttachment(metadata, blobStore.open(metadata.storagePath))
    }

    @Transactional(readOnly = true)
    fun openRetained(userId: Long, noteId: UUID, attachmentId: UUID): StoredAttachment {
        noteRepository.findByIdAndUserIdAndDeletedAtIsNull(noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        val metadata = attachmentRepository.findOwnedOnNote(attachmentId, noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "attachment_not_found", "Attachment not found")
        val deletedAt = metadata.deletedAt
            ?: throw ApiException(HttpStatus.NOT_FOUND, "attachment_not_found", "Attachment not found")
        val cutoff = clock.instant().minus(properties.noteRevisionRetention)
        if (deletedAt.isBefore(cutoff)) {
            throw ApiException(HttpStatus.NOT_FOUND, "attachment_not_found", "Attachment not found")
        }
        if (!blobStore.exists(metadata.storagePath)) {
            throw ApiException(HttpStatus.NOT_FOUND, "attachment_bytes_missing", "Attachment bytes are unavailable")
        }
        return StoredAttachment(metadata, blobStore.open(metadata.storagePath))
    }

    @Transactional
    fun delete(userId: Long, id: UUID) {
        val metadata = attachmentRepository.findOwnedActive(id, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "attachment_not_found", "Attachment not found")
        val note = noteRepository.findByIdAndUserIdAndDeletedAtIsNull(metadata.noteId, userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "note_not_found", "Note not found")
        metadata.deletedAt = clock.instant()
        attachmentRepository.save(metadata)
        note.updatedAt = clock.instant()
        noteRepository.save(note)
    }

    private fun AttachmentEntity.toResponse() = AttachmentResponse(
        id = id,
        metaCiphertext = CryptoSupport.encode(metaCiphertext),
        sizeBytes = sizeBytes,
        createdAt = createdAt,
        url = "/attachments/$id",
    )
}

@RestController
class AttachmentController(private val attachmentService: AttachmentService) {
    @PostMapping("/notes/{noteId}/attachments", consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun upload(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @RequestPart("file") file: MultipartFile,
        @RequestPart("metaCiphertext") metaCiphertext: String,
        @RequestPart(name = "attachmentId", required = false) attachmentId: String?,
    ): ResponseEntity<AttachmentResponse> {
        val principal = authentication.principal as OwnKeepPrincipal
        val parsedId = attachmentId?.let {
            try {
                UUID.fromString(it.trim())
            } catch (_: IllegalArgumentException) {
                throw ApiException(HttpStatus.BAD_REQUEST, "invalid_attachment_id", "attachmentId must be a UUID")
            }
        }
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(attachmentService.upload(principal.userId, noteId, file, metaCiphertext, parsedId))
    }

    @GetMapping("/attachments/{id}")
    fun download(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: UUID,
    ): ResponseEntity<InputStreamResource> {
        val principal = authentication.principal as OwnKeepPrincipal
        return attachmentResponse(attachmentService.open(principal.userId, id))
    }

    @GetMapping("/notes/{noteId}/retained-attachments/{attachmentId}")
    fun downloadRetained(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable noteId: UUID,
        @PathVariable attachmentId: UUID,
    ): ResponseEntity<InputStreamResource> {
        val principal = authentication.principal as OwnKeepPrincipal
        return attachmentResponse(attachmentService.openRetained(principal.userId, noteId, attachmentId))
    }

    @DeleteMapping("/attachments/{id}")
    fun delete(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: UUID,
    ): ResponseEntity<Void> {
        val principal = authentication.principal as OwnKeepPrincipal
        attachmentService.delete(principal.userId, id)
        return ResponseEntity.noContent().build()
    }

    private fun attachmentResponse(stored: StoredAttachment): ResponseEntity<InputStreamResource> {
        val disposition = ContentDisposition.attachment()
            .filename("attachment.bin", StandardCharsets.UTF_8)
            .build()
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
            .header("X-Content-Type-Options", "nosniff")
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
            .contentLength(stored.metadata.sizeBytes)
            .body(InputStreamResource(stored.content))
    }
}
