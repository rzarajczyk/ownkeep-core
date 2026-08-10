package com.ownkeep.api

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Size
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.core.userdetails.UserDetails
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource
import org.springframework.stereotype.Component
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import org.springframework.web.filter.OncePerRequestFilter
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.Base64

data class LoginRequest(
    @field:NotBlank
    @field:Size(max = 255)
    val email: String,
    @field:NotBlank
    @field:Size(max = 1024)
    val password: String,
)

data class ChangePasswordRequest(
    @field:NotBlank
    @field:Size(max = 1024)
    val currentPassword: String,
    @field:NotBlank
    @field:Size(max = 1024)
    val newPassword: String,
    @field:NotBlank
    val wrappedVaultKey: String,
)

data class CompleteRecoveryRequest(
    @field:NotBlank
    @field:Size(max = 1024)
    val newPassword: String,
    @field:NotBlank
    @field:Size(max = 4096)
    val wrappedVaultKey: String,
)

data class KdfParamsDto(
    val alg: String,
    val m: Int,
    val t: Int,
    val p: Int,
)

data class VaultInfo(
    val kdfSalt: String?,
    val kdfParams: KdfParamsDto?,
    val wrappedVaultKey: String?,
    val wrappedVaultKeyRecovery: String?,
    val hasRecoveryKey: Boolean,
    val initialized: Boolean,
    val needsRecoveryUnlock: Boolean,
)

data class InitializeVaultRequest(
    @field:NotBlank
    val kdfSalt: String,
    @field:Valid
    val kdfParams: KdfParamsDto,
    @field:NotBlank
    val wrappedVaultKey: String,
    @field:NotBlank
    val wrappedVaultKeyRecovery: String,
)

data class UpdateVaultWrapRequest(
    @field:NotBlank
    val wrappedVaultKey: String,
    val wrappedVaultKeyRecovery: String? = null,
)

data class MeResponse(
    val id: Long,
    val email: String,
    val role: UserRole,
    val vault: VaultInfo,
)

data class LoginResponse(
    val token: String,
    val expiresAt: Instant,
    val user: MeResponse,
    val recoveryRequired: Boolean,
)

data class OwnKeepPrincipal(
    val userId: Long,
    private val email: String,
    val role: UserRole,
    val tokenHash: String,
) : UserDetails {
    override fun getAuthorities() = listOf(SimpleGrantedAuthority("ROLE_${role.name}"))
    override fun getPassword() = ""
    override fun getUsername() = email
    override fun isAccountNonExpired() = true
    override fun isAccountNonLocked() = true
    override fun isCredentialsNonExpired() = true
    override fun isEnabled() = true
}

fun validateUserPassword(password: String, label: String = "password") {
    if (password.isBlank()) {
        throw ApiException(HttpStatus.BAD_REQUEST, "invalid_password", "$label must not be blank")
    }
    if (password.toByteArray(StandardCharsets.UTF_8).size > 72) {
        throw ApiException(
            HttpStatus.BAD_REQUEST,
            "invalid_password",
            "$label exceeds bcrypt's 72-byte limit",
        )
    }
}

@Service
class AdminBootstrapService(
    private val userRepository: UserRepository,
    private val passwordEncoder: PasswordEncoder,
) {
    fun hasEnabledAdmin(): Boolean = userRepository.existsByRoleAndEnabledTrue(UserRole.ADMIN)

    @Transactional
    fun bootstrap(emailRaw: String, password: String) {
        if (hasEnabledAdmin()) return

        val email = validateUserEmail(emailRaw)
        validateUserPassword(password, "admin password")
        val now = Instant.now()
        val existing = userRepository.findByEmail(email)
        if (existing != null) {
            if (!existing.enabled) {
                throw IllegalStateException(
                    "OWNKEEP_ADMIN_EMAIL matches a disabled user; re-enable or choose a different admin email",
                )
            }
            existing.role = UserRole.ADMIN
            existing.passwordHash = passwordEncoder.encode(password)
            existing.emailVerifiedAt = now
            existing.updatedAt = now
            userRepository.save(existing)
            return
        }

        userRepository.save(
            UserEntity(
                email = email,
                passwordHash = passwordEncoder.encode(password),
                enabled = true,
                role = UserRole.ADMIN,
                emailVerifiedAt = now,
                createdAt = now,
                updatedAt = now,
            ),
        )
    }
}

@Component
class AdminBootstrapRunner(
    private val properties: OwnKeepProperties,
    private val bootstrapService: AdminBootstrapService,
) : ApplicationRunner {
    override fun run(args: ApplicationArguments) {
        require(properties.tokenTtl.isNegative.not() && properties.tokenTtl.isZero.not()) {
            "ownkeep.token-ttl must be positive"
        }
        require(properties.deletedUserRetention.isNegative.not() && properties.deletedUserRetention.isZero.not()) {
            "ownkeep.deleted-user-retention must be positive"
        }
        require(properties.noteRevisionRetention.isNegative.not() && properties.noteRevisionRetention.isZero.not()) {
            "ownkeep.note-revision-retention must be positive"
        }
        require(properties.maxSyncLimit > 0) { "ownkeep.max-sync-limit must be positive" }
        require(properties.loginRateLimit.maxAttemptsPerIp > 0) {
            "ownkeep.login-rate-limit.max-attempts-per-ip must be positive"
        }
        require(properties.loginRateLimit.maxAttemptsPerEmail > 0) {
            "ownkeep.login-rate-limit.max-attempts-per-email must be positive"
        }
        require(!properties.loginRateLimit.window.isNegative && !properties.loginRateLimit.window.isZero) {
            "ownkeep.login-rate-limit.window must be positive"
        }
        require(properties.attachment.maxFileSize > 0) { "ownkeep.attachment.max-file-size must be positive" }
        require(properties.attachment.perUserQuota > 0) { "ownkeep.attachment.per-user-quota must be positive" }

        if (bootstrapService.hasEnabledAdmin()) return

        if (properties.adminEmail.isBlank() || properties.adminPassword.isBlank()) {
            throw IllegalStateException(
                "OWNKEEP_ADMIN_EMAIL and OWNKEEP_ADMIN_PASSWORD are required when no admin user exists",
            )
        }
        if (properties.emailVerificationRequired) {
            require(properties.publicBaseUrl.isNotBlank()) {
                "OWNKEEP_PUBLIC_BASE_URL is required when email verification is enabled"
            }
            require(properties.mail.host.isNotBlank()) {
                "OWNKEEP_MAIL_HOST is required when email verification is enabled"
            }
            require(properties.mail.from.isNotBlank() || properties.mail.username.isNotBlank()) {
                "OWNKEEP_MAIL_FROM or OWNKEEP_MAIL_USERNAME is required when email verification is enabled"
            }
        }
        bootstrapService.bootstrap(properties.adminEmail, properties.adminPassword)
    }
}

@Service
class AuthService(
    private val userRepository: UserRepository,
    private val authTokenRepository: AuthTokenRepository,
    private val passwordEncoder: PasswordEncoder,
    private val properties: OwnKeepProperties,
) {
    private val secureRandom = SecureRandom()
    private val clock: Clock = Clock.systemUTC()

    @Transactional
    fun login(request: LoginRequest): LoginResponse {
        val user = userRepository.findByEmail(normalizeEmail(request.email))
        val passwordWithinBcryptLimit = request.password.toByteArray(StandardCharsets.UTF_8).size <= 72
        val passwordMatches = passwordWithinBcryptLimit && runCatching {
            passwordEncoder.matches(request.password, user?.passwordHash ?: DUMMY_PASSWORD_HASH)
        }.getOrDefault(false)
        val valid = user != null && user.enabled && passwordMatches
        if (!valid) throw ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "Invalid email or password")
        if (
            properties.emailVerificationRequired &&
            user.role != UserRole.ADMIN &&
            !user.emailVerified
        ) {
            throw ApiException(
                HttpStatus.FORBIDDEN,
                "email_not_verified",
                "Verify your email before signing in",
            )
        }

        val purpose = if (user.recoveryPending) AuthTokenPurpose.RECOVERY else AuthTokenPurpose.SESSION
        return issueLogin(user, purpose)
    }

    @Transactional
    fun completeRecovery(rawToken: String, request: CompleteRecoveryRequest): LoginResponse {
        if (rawToken.length !in 32..256) {
            throw ApiException(HttpStatus.UNAUTHORIZED, "invalid_recovery_token", "Invalid recovery token")
        }

        val now = clock.instant()
        val token = authTokenRepository.findValidForUpdate(
            hashToken(rawToken),
            AuthTokenPurpose.RECOVERY,
            now,
        ) ?: throw ApiException(HttpStatus.UNAUTHORIZED, "invalid_recovery_token", "Invalid recovery token")
        val user = userRepository.findForUpdateById(token.userId)
            ?: throw ApiException(HttpStatus.UNAUTHORIZED, "invalid_recovery_token", "Invalid recovery token")
        if (!user.enabled || !user.recoveryPending) {
            throw ApiException(HttpStatus.UNAUTHORIZED, "invalid_recovery_token", "Invalid recovery token")
        }

        validateUserPassword(request.newPassword, "new password")
        val wrappedVaultKey = CryptoSupport.decodeRequired(
            request.wrappedVaultKey,
            "wrappedVaultKey",
            minBytes = 28,
            maxBytes = 512,
        )
        user.passwordHash = passwordEncoder.encode(request.newPassword)
        user.wrappedVaultKey = wrappedVaultKey
        user.recoveryPending = false
        user.updatedAt = now
        userRepository.save(user)
        authTokenRepository.revokeAllForUser(requireNotNull(user.id), now)
        return issueLogin(user, AuthTokenPurpose.SESSION, now)
    }

    private fun issueLogin(
        user: UserEntity,
        purpose: AuthTokenPurpose,
        now: Instant = clock.instant(),
    ): LoginResponse {
        val rawTokenBytes = ByteArray(32).also(secureRandom::nextBytes)
        val rawToken = Base64.getUrlEncoder().withoutPadding().encodeToString(rawTokenBytes)
        val expiresAt = now.plus(properties.tokenTtl)
        authTokenRepository.save(
            AuthTokenEntity(
                userId = requireNotNull(user.id),
                tokenHash = hashToken(rawToken),
                expiresAt = expiresAt,
                createdAt = now,
                purpose = purpose,
            ),
        )
        authTokenRepository.deleteExpiredAndRevokedBefore(now.minusSeconds(7 * 24 * 60 * 60))
        return LoginResponse(
            rawToken,
            expiresAt,
            toMeResponse(user),
            recoveryRequired = purpose == AuthTokenPurpose.RECOVERY,
        )
    }

    @Transactional(readOnly = true)
    fun me(userId: Long): MeResponse {
        val user = userRepository.findById(userId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        return toMeResponse(user)
    }

    @Transactional
    fun initializeVault(userId: Long, request: InitializeVaultRequest): VaultInfo {
        val user = userRepository.findById(userId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (user.vaultInitialized) {
            throw ApiException(HttpStatus.CONFLICT, "vault_exists", "Vault is already initialized")
        }
        validateKdfParams(request.kdfParams)
        user.kdfSalt = CryptoSupport.decodeRequired(request.kdfSalt, "kdfSalt", minBytes = 16, maxBytes = 64)
        user.kdfParams = VAULT_JSON.writeValueAsString(request.kdfParams)
        user.wrappedVaultKey = CryptoSupport.decodeRequired(
            request.wrappedVaultKey,
            "wrappedVaultKey",
            minBytes = 28,
            maxBytes = 512,
        )
        user.wrappedVaultKeyRecovery = CryptoSupport.decodeRequired(
            request.wrappedVaultKeyRecovery,
            "wrappedVaultKeyRecovery",
            minBytes = 28,
            maxBytes = 512,
        )
        user.vaultInitializedAt = clock.instant()
        user.updatedAt = clock.instant()
        userRepository.save(user)
        return toVaultInfo(user)
    }

    @Transactional
    fun updateVaultWrap(userId: Long, request: UpdateVaultWrapRequest): VaultInfo {
        val user = userRepository.findById(userId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (user.wrappedVaultKeyRecovery == null || user.kdfSalt == null) {
            throw ApiException(HttpStatus.BAD_REQUEST, "vault_not_initialized", "Vault is not initialized")
        }
        // Password wrap may have been cleared by admin reset; recovery wrap must remain.
        user.wrappedVaultKey = CryptoSupport.decodeRequired(
            request.wrappedVaultKey,
            "wrappedVaultKey",
            minBytes = 28,
            maxBytes = 512,
        )
        request.wrappedVaultKeyRecovery?.let {
            user.wrappedVaultKeyRecovery = CryptoSupport.decodeRequired(
                it,
                "wrappedVaultKeyRecovery",
                minBytes = 28,
                maxBytes = 512,
            )
        }
        if (user.vaultInitializedAt == null) {
            user.vaultInitializedAt = clock.instant()
        }
        user.updatedAt = clock.instant()
        userRepository.save(user)
        return toVaultInfo(user)
    }

    @Transactional(readOnly = true)
    fun authenticate(rawToken: String): OwnKeepPrincipal? {
        if (rawToken.length !in 32..256) return null
        val token = authTokenRepository.findByTokenHashAndPurposeAndRevokedAtIsNullAndExpiresAtAfter(
            hashToken(rawToken),
            AuthTokenPurpose.SESSION,
            clock.instant(),
        )
            ?: return null
        val user = userRepository.findById(token.userId).orElse(null) ?: return null
        if (!user.enabled) return null
        return OwnKeepPrincipal(requireNotNull(user.id), user.email, user.role, token.tokenHash)
    }

    @Transactional
    fun logout(tokenHash: String) {
        authTokenRepository.revoke(tokenHash, clock.instant())
    }

    @Transactional
    fun changePassword(userId: Long, request: ChangePasswordRequest) {
        validateUserPassword(request.newPassword, "new password")
        val user = userRepository.findById(userId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (!user.vaultInitialized) {
            throw ApiException(
                HttpStatus.BAD_REQUEST,
                "vault_not_initialized",
                "Initialize the vault before changing password",
            )
        }
        val currentWithinLimit = request.currentPassword.toByteArray(StandardCharsets.UTF_8).size <= 72
        val matches = currentWithinLimit && runCatching {
            passwordEncoder.matches(request.currentPassword, user.passwordHash)
        }.getOrDefault(false)
        if (!matches) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_credentials", "Current password is incorrect")
        }
        val now = clock.instant()
        user.passwordHash = passwordEncoder.encode(request.newPassword)
        user.wrappedVaultKey = CryptoSupport.decodeRequired(
            request.wrappedVaultKey,
            "wrappedVaultKey",
            minBytes = 28,
            maxBytes = 512,
        )
        user.updatedAt = now
        userRepository.save(user)
        authTokenRepository.revokeAllForUser(userId, now)
    }

    companion object {
        private const val DUMMY_PASSWORD_HASH = "\$2a\$12\$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"
        private val VAULT_JSON = jacksonObjectMapper()

        fun hashToken(rawToken: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(rawToken.toByteArray(StandardCharsets.UTF_8))
                .joinToString("") { "%02x".format(it) }

        fun validateKdfParams(params: KdfParamsDto) {
            if (params.alg != "argon2id") {
                throw ApiException(HttpStatus.BAD_REQUEST, "invalid_kdf", "Unsupported KDF algorithm")
            }
            if (params.m !in 8_192..1_048_576 || params.t !in 1..10 || params.p !in 1..4) {
                throw ApiException(HttpStatus.BAD_REQUEST, "invalid_kdf", "Invalid KDF parameters")
            }
        }

        fun toVaultInfo(user: UserEntity): VaultInfo {
            val params = user.kdfParams?.let { raw ->
                runCatching { VAULT_JSON.readValue<KdfParamsDto>(raw) }.getOrNull()
            }
            return VaultInfo(
                kdfSalt = user.kdfSalt?.let(CryptoSupport::encode),
                kdfParams = params,
                wrappedVaultKey = user.wrappedVaultKey?.let(CryptoSupport::encode),
                wrappedVaultKeyRecovery = user.wrappedVaultKeyRecovery?.let(CryptoSupport::encode),
                hasRecoveryKey = user.wrappedVaultKeyRecovery != null,
                initialized = user.vaultInitialized,
                needsRecoveryUnlock = user.vaultInitialized && user.wrappedVaultKey == null,
            )
        }

        fun toMeResponse(user: UserEntity) = MeResponse(
            id = requireNotNull(user.id),
            email = user.email,
            role = user.role,
            vault = toVaultInfo(user),
        )
    }
}

/**
 * Fixed-window rate limiter for login attempts.
 * Limits by client IP and by login name so both single-IP floods and
 * distributed guessing against one account are throttled.
 */
class LoginRateLimiter(
    private val properties: OwnKeepProperties,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val buckets = java.util.concurrent.ConcurrentHashMap<String, Window>()

    fun check(clientIp: String, email: String) {
        val config = properties.loginRateLimit
        val retryAfter = consume("ip:$clientIp", config.maxAttemptsPerIp, config.window)
            ?: consume("email:${normalizeEmail(email)}", config.maxAttemptsPerEmail, config.window)
        if (retryAfter != null) {
            throw ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many login attempts. Try again later.",
                retryAfterSeconds = retryAfter,
            )
        }
    }

    /** Returns remaining seconds until the window resets when limited; null when allowed. */
    fun consume(key: String, maxAttempts: Int, window: Duration): Long? {
        if (maxAttempts <= 0) return null
        val now = clock.instant()
        val windowMillis = window.toMillis().coerceAtLeast(1)
        var retryAfterSeconds: Long? = null
        buckets.compute(key) { _, existing ->
            if (existing == null || now.isAfter(existing.start.plusMillis(windowMillis))) {
                Window(now)
            } else {
                val count = existing.count.incrementAndGet()
                if (count > maxAttempts) {
                    val elapsed = java.time.Duration.between(existing.start, now).toMillis()
                    retryAfterSeconds = ((windowMillis - elapsed + 999) / 1000).coerceAtLeast(1)
                }
                existing
            }
        }
        maybePrune(now, windowMillis)
        return retryAfterSeconds
    }

    private fun maybePrune(now: Instant, windowMillis: Long) {
        if (buckets.size < 1_000) return
        buckets.entries.removeIf { (_, window) -> now.isAfter(window.start.plusMillis(windowMillis * 2)) }
    }

    private class Window(
        val start: Instant,
        val count: java.util.concurrent.atomic.AtomicInteger = java.util.concurrent.atomic.AtomicInteger(1),
    )
}

@Component
class TokenAuthenticationFilter(private val authService: AuthService) : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        val header = request.getHeader("Authorization")
        if (SecurityContextHolder.getContext().authentication == null && header?.startsWith("Bearer ") == true) {
            val rawToken = header.substring(7).trim()
            authService.authenticate(rawToken)?.let { principal ->
                val authentication = UsernamePasswordAuthenticationToken(principal, null, principal.authorities)
                authentication.details = WebAuthenticationDetailsSource().buildDetails(request)
                SecurityContextHolder.getContext().authentication = authentication
            }
        }
        filterChain.doFilter(request, response)
    }
}

@RestController
@RequestMapping("/auth")
class AuthController(
    private val authService: AuthService,
    private val loginRateLimiter: LoginRateLimiter,
    private val emailVerificationService: EmailVerificationService,
) {
    @PostMapping("/login")
    fun login(
        @Valid @RequestBody request: LoginRequest,
        httpRequest: HttpServletRequest,
    ): LoginResponse {
        loginRateLimiter.check(clientIp(httpRequest), request.email)
        return authService.login(request)
    }

    @PostMapping("/recovery/complete")
    fun completeRecovery(
        @RequestHeader(name = "Authorization", required = false) authorization: String?,
        @Valid @RequestBody request: CompleteRecoveryRequest,
    ): LoginResponse {
        val rawToken = authorization
            ?.takeIf { it.startsWith("Bearer ") }
            ?.substring(7)
            ?.trim()
            .orEmpty()
        return authService.completeRecovery(rawToken, request)
    }

    @PostMapping("/email/verify")
    fun verifyEmail(@RequestBody request: VerifyEmailRequest): ResponseEntity<Void> {
        emailVerificationService.confirm(request.token.trim())
        return ResponseEntity.noContent().build()
    }

    @PostMapping("/email/resend")
    fun resendVerification(
        @RequestBody request: ResendVerificationRequest,
        httpRequest: HttpServletRequest,
    ): Map<String, String> {
        emailVerificationService.resend(request.email, clientIp(httpRequest))
        return mapOf("message" to "If an account needs verification, a message has been sent.")
    }

    @PostMapping("/logout")
    fun logout(authentication: UsernamePasswordAuthenticationToken): ResponseEntity<Void> {
        val principal = authentication.principal as OwnKeepPrincipal
        authService.logout(principal.tokenHash)
        return ResponseEntity.noContent().build()
    }

    private fun clientIp(request: HttpServletRequest): String =
        request.remoteAddr?.takeIf { it.isNotBlank() } ?: "unknown"
}

@RestController
class MeController(
    private val authService: AuthService,
    private val userManagementService: UserManagementService,
) {
    @GetMapping("/me")
    fun me(authentication: UsernamePasswordAuthenticationToken): MeResponse {
        val principal = authentication.principal as OwnKeepPrincipal
        return authService.me(principal.userId)
    }

    @PostMapping("/me/vault")
    fun initializeVault(
        authentication: UsernamePasswordAuthenticationToken,
        @Valid @RequestBody request: InitializeVaultRequest,
    ): VaultInfo {
        val principal = authentication.principal as OwnKeepPrincipal
        return authService.initializeVault(principal.userId, request)
    }

    @PutMapping("/me/vault/wrap")
    fun updateVaultWrap(
        authentication: UsernamePasswordAuthenticationToken,
        @Valid @RequestBody request: UpdateVaultWrapRequest,
    ): VaultInfo {
        val principal = authentication.principal as OwnKeepPrincipal
        return authService.updateVaultWrap(principal.userId, request)
    }

    @PatchMapping("/me/password")
    fun changePassword(
        authentication: UsernamePasswordAuthenticationToken,
        @Valid @RequestBody request: ChangePasswordRequest,
    ): ResponseEntity<Void> {
        val principal = authentication.principal as OwnKeepPrincipal
        authService.changePassword(principal.userId, request)
        return ResponseEntity.noContent().build()
    }

    @DeleteMapping("/me")
    fun deleteAccount(
        authentication: UsernamePasswordAuthenticationToken,
        @Valid @RequestBody request: DeleteAccountRequest,
    ): ResponseEntity<Void> {
        val principal = authentication.principal as OwnKeepPrincipal
        userManagementService.softDeleteOwnAccount(principal.userId, request)
        return ResponseEntity.noContent().build()
    }
}
