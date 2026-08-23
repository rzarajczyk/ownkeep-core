package com.ownkeep.api

import com.ownkeep.api.storage.AttachmentBlobStore
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.time.Clock
import java.time.Instant
import java.util.Base64

data class UserSummaryResponse(
    val id: Long,
    val email: String,
    val role: UserRole,
    val enabled: Boolean,
    val emailVerified: Boolean,
    val recoveryPending: Boolean,
    val canRestore: Boolean,
    val deletedAt: Instant? = null,
)

data class RestoreUserResponse(
    val user: UserSummaryResponse,
    val temporaryPassword: String,
)

data class CreateUserRequest(
    @field:NotBlank
    @field:Size(max = 254)
    val email: String,
    @field:NotBlank
    @field:Size(max = 1024)
    val password: String,
)

data class ResetPasswordRequest(
    @field:NotBlank
    @field:Size(max = 1024)
    val newPassword: String,
)

data class DeleteAccountRequest(
    @field:NotBlank
    @field:Size(max = 1024)
    val password: String,
)

@Service
class UserManagementService(
    private val userRepository: UserRepository,
    private val authTokenRepository: AuthTokenRepository,
    private val attachmentRepository: AttachmentRepository,
    private val attachmentBlobStore: AttachmentBlobStore,
    private val passwordEncoder: PasswordEncoder,
    private val userProvisioningService: UserProvisioningService,
    private val emailVerificationService: EmailVerificationService,
) {
    private val clock: Clock = Clock.systemUTC()
    private val secureRandom = SecureRandom()

    @Transactional(readOnly = true)
    fun listUsers(): List<UserSummaryResponse> =
        userRepository.findAllForAdministration().map { it.toSummary() }

    @Transactional
    fun createUser(request: CreateUserRequest): UserSummaryResponse {
        val provisioned = userProvisioningService.provision(
            ProvisionUserRequest(
                email = request.email,
                password = request.password,
                role = UserRole.USER,
            ),
        )
        return provisioned.user.toSummary()
    }

    @Transactional
    fun softDeleteUser(actorId: Long, targetId: Long): UserSummaryResponse {
        if (actorId == targetId) {
            throw ApiException(HttpStatus.BAD_REQUEST, "cannot_delete_self", "You cannot delete your own account")
        }
        val user = userRepository.findById(targetId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (!user.enabled) {
            throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        }
        if (user.role == UserRole.ADMIN) {
            throw ApiException(HttpStatus.BAD_REQUEST, "cannot_delete_admin", "The admin account cannot be deleted")
        }
        return markUserDeleted(user).toSummary()
    }

    @Transactional
    fun softDeleteOwnAccount(userId: Long, request: DeleteAccountRequest) {
        val user = userRepository.findForUpdateById(userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (!user.enabled) {
            throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        }
        val passwordWithinLimit = request.password.toByteArray(StandardCharsets.UTF_8).size <= 72
        val matches = passwordWithinLimit && runCatching {
            passwordEncoder.matches(request.password, user.passwordHash)
        }.getOrDefault(false)
        if (!matches) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_credentials", "Current password is incorrect")
        }
        if (user.role == UserRole.ADMIN && !userRepository.existsByRoleAndEnabledTrueAndIdNot(UserRole.ADMIN, userId)) {
            throw ApiException(
                HttpStatus.BAD_REQUEST,
                "cannot_delete_last_admin",
                "Cannot delete the last admin account",
            )
        }
        markUserDeleted(user)
    }

    @Transactional
    fun restoreUser(targetId: Long): RestoreUserResponse {
        val user = userRepository.findForUpdateById(targetId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (user.enabled) {
            throw ApiException(HttpStatus.CONFLICT, "user_not_deleted", "User is not deleted")
        }
        if (!user.vaultInitialized) {
            throw ApiException(
                HttpStatus.CONFLICT,
                "vault_not_initialized",
                "User has no initialized recovery vault",
            )
        }

        val temporaryPassword = generateTemporaryPassword()
        val now = clock.instant()
        user.passwordHash = passwordEncoder.encode(temporaryPassword)
        user.enabled = true
        user.deletedAt = null
        user.recoveryPending = true
        user.wrappedVaultKey = null
        user.updatedAt = now
        userRepository.save(user)
        authTokenRepository.revokeAllForUser(requireNotNull(user.id), now)
        return RestoreUserResponse(user.toSummary(), temporaryPassword)
    }

    @Transactional
    fun permanentlyDeleteUser(targetId: Long) {
        val user = userRepository.findForUpdateById(targetId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (user.enabled) {
            throw ApiException(HttpStatus.CONFLICT, "user_not_deleted", "User must be deleted first")
        }

        val userId = requireNotNull(user.id)
        val storagePaths = attachmentRepository.findStoragePathsByUserId(userId)
        userRepository.delete(user)
        attachmentBlobStore.deleteAfterCommit(storagePaths)
    }

    @Transactional
    fun purgeExpiredDeletedUsers(retentionCutoff: Instant): Int {
        val expired = userRepository.findByEnabledFalseAndDeletedAtLessThanEqual(retentionCutoff)
        var purged = 0
        for (user in expired) {
            val userId = requireNotNull(user.id)
            val storagePaths = attachmentRepository.findStoragePathsByUserId(userId)
            userRepository.delete(user)
            attachmentBlobStore.deleteAfterCommit(storagePaths)
            purged += 1
        }
        return purged
    }

    @Transactional
    fun resetPassword(actorId: Long, targetId: Long, request: ResetPasswordRequest) {
        if (actorId == targetId) {
            throw ApiException(
                HttpStatus.BAD_REQUEST,
                "use_settings",
                "Use user settings to change your own password",
            )
        }
        validateUserPassword(request.newPassword, "new password")
        val user = userRepository.findById(targetId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (!user.enabled) {
            throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        }
        val now = clock.instant()
        user.passwordHash = passwordEncoder.encode(request.newPassword)
        // Clear password wrap only; recovery wrap remains so the user can re-bind a password wrap.
        user.wrappedVaultKey = null
        user.updatedAt = now
        userRepository.save(user)
        authTokenRepository.revokeAllForUser(requireNotNull(user.id), now)
    }

    fun resendVerification(targetId: Long) {
        emailVerificationService.resendForUser(targetId)
    }

    private fun markUserDeleted(user: UserEntity): UserEntity {
        val now = clock.instant()
        user.enabled = false
        user.deletedAt = now
        user.recoveryPending = false
        user.updatedAt = now
        val deleted = userRepository.save(user)
        authTokenRepository.revokeAllForUser(requireNotNull(user.id), now)
        return deleted
    }

    private fun generateTemporaryPassword(): String =
        ByteArray(32)
            .also(secureRandom::nextBytes)
            .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    private fun UserEntity.toSummary() =
        UserSummaryResponse(
            id = requireNotNull(id),
            email = email,
            role = role,
            enabled = enabled,
            emailVerified = emailVerified,
            recoveryPending = recoveryPending,
            canRestore = !enabled && vaultInitialized,
            deletedAt = deletedAt,
        )
}

@Component
class DeletedUserPurgeScheduler(
    private val properties: OwnKeepProperties,
    private val userManagementService: UserManagementService,
    private val idleJdbcConnectionReleaser: IdleJdbcConnectionReleaser,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val clock: Clock = Clock.systemUTC()

    @Scheduled(cron = "0 15 3 * * *")
    fun purgeExpiredDeletedUsers() {
        try {
            val retention = properties.deletedUserRetention
            if (retention.isNegative || retention.isZero) return
            val cutoff = clock.instant().minus(retention)
            val purged = userManagementService.purgeExpiredDeletedUsers(cutoff)
            if (purged > 0) {
                log.info("Permanently deleted {} soft-deleted account(s) past retention", purged)
            }
        } finally {
            idleJdbcConnectionReleaser.releaseIdleConnections()
        }
    }
}

@RestController
@RequestMapping("/users")
@PreAuthorize("hasRole('ADMIN')")
class UsersController(private val userManagementService: UserManagementService) {
    @GetMapping
    fun list(): List<UserSummaryResponse> = userManagementService.listUsers()

    @PostMapping
    fun create(@Valid @RequestBody request: CreateUserRequest): UserSummaryResponse =
        userManagementService.createUser(request)

    @DeleteMapping("/{id}")
    fun delete(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: Long,
    ): UserSummaryResponse {
        val principal = authentication.principal as OwnKeepPrincipal
        return userManagementService.softDeleteUser(principal.userId, id)
    }

    @PostMapping("/{id}/restore")
    fun restore(@PathVariable id: Long): RestoreUserResponse =
        userManagementService.restoreUser(id)

    @DeleteMapping("/{id}/permanent")
    fun permanentlyDelete(@PathVariable id: Long): ResponseEntity<Void> {
        userManagementService.permanentlyDeleteUser(id)
        return ResponseEntity.noContent().build()
    }

    @PostMapping("/{id}/reset-password")
    fun resetPassword(
        authentication: UsernamePasswordAuthenticationToken,
        @PathVariable id: Long,
        @Valid @RequestBody request: ResetPasswordRequest,
    ): ResponseEntity<Void> {
        val principal = authentication.principal as OwnKeepPrincipal
        userManagementService.resetPassword(principal.userId, id, request)
        return ResponseEntity.noContent().build()
    }

    @PostMapping("/{id}/resend-verification")
    fun resendVerification(@PathVariable id: Long): ResponseEntity<Void> {
        userManagementService.resendVerification(id)
        return ResponseEntity.noContent().build()
    }
}
