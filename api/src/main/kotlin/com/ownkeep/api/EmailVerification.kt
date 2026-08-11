package com.ownkeep.api

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpStatus
import org.springframework.mail.SimpleMailMessage
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.mail.javamail.JavaMailSenderImpl
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager
import org.slf4j.LoggerFactory
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Clock
import java.time.Instant
import java.util.Base64
import java.util.Properties
import java.util.UUID

fun interface EmailSender {
    fun send(to: String, subject: String, body: String)
}

@Configuration
class MailConfig {
    @Bean
    fun javaMailSender(properties: OwnKeepProperties): JavaMailSender {
        val sender = JavaMailSenderImpl()
        sender.host = properties.mail.host.ifBlank { "localhost" }
        sender.port = properties.mail.port
        sender.username = properties.mail.username.ifBlank { null }
        sender.password = properties.mail.password.ifBlank { null }
        val props = Properties()
        props["mail.smtp.auth"] = properties.mail.smtpAuth.toString()
        props["mail.smtp.starttls.enable"] = properties.mail.startTls.toString()
        sender.javaMailProperties = props
        return sender
    }
}

class EmailDeliveryService(
    private val properties: OwnKeepProperties,
    private val mailSender: JavaMailSender?,
) : EmailSender {
    private val log = LoggerFactory.getLogger(javaClass)

    override fun send(to: String, subject: String, body: String) {
        if (properties.mail.host.isBlank() || mailSender == null) {
            log.debug("Email delivery skipped (SMTP not configured): subject={}", subject)
            return
        }
        val message = SimpleMailMessage()
        message.setTo(to)
        message.from = properties.mail.from.ifBlank {
            properties.mail.username.ifBlank { "noreply@localhost" }
        }
        message.subject = subject
        message.text = body
        mailSender.send(message)
    }
}

data class VerifyEmailRequest(val token: String)
data class ResendVerificationRequest(val email: String)

@Service
class EmailVerificationService(
    private val userRepository: UserRepository,
    private val tokenRepository: EmailVerificationTokenRepository,
    private val emailSender: EmailDeliveryService,
    private val properties: OwnKeepProperties,
    private val loginRateLimiter: LoginRateLimiter,
) {
    private val secureRandom = SecureRandom()
    private val clock: Clock = Clock.systemUTC()
    private val log = LoggerFactory.getLogger(javaClass)

    @Transactional
    fun issueAndSendAfterCommit(user: UserEntity) {
        if (!properties.emailVerificationRequired) return
        if (user.role == UserRole.ADMIN || user.emailVerified) return
        val rawToken = createToken(requireNotNull(user.id))
        val email = user.email
        val link = verificationLink(rawToken)
        afterCommit {
            try {
                emailSender.send(
                    to = email,
                    subject = "Verify your OwnKeep email",
                    body = "Verify your OwnKeep account by opening this link:\n\n$link\n\n" +
                        "If you did not create this account, you can ignore this email.",
                )
            } catch (ex: Exception) {
                log.warn("Failed to send verification email", ex)
            }
        }
    }

    fun createToken(userId: Long): String {
        val now = clock.instant()
        tokenRepository.consumeAllForUser(userId, now)
        val raw = ByteArray(32).also(secureRandom::nextBytes)
            .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        tokenRepository.save(
            EmailVerificationTokenEntity(
                id = UUID.randomUUID(),
                userId = userId,
                tokenHash = hashToken(raw),
                expiresAt = now.plus(properties.emailVerificationTokenTtl),
                createdAt = now,
            ),
        )
        return raw
    }

    @Transactional
    fun confirm(rawToken: String) {
        if (rawToken.length !in 16..256) {
            throw ApiException(HttpStatus.BAD_REQUEST, "invalid_verification_token", "Invalid verification token")
        }
        val now = clock.instant()
        val token = tokenRepository.findValidForUpdate(hashToken(rawToken), now)
            ?: throw ApiException(HttpStatus.BAD_REQUEST, "invalid_verification_token", "Invalid verification token")
        val user = userRepository.findForUpdateById(token.userId)
            ?: throw ApiException(HttpStatus.BAD_REQUEST, "invalid_verification_token", "Invalid verification token")
        token.consumedAt = now
        tokenRepository.save(token)
        tokenRepository.consumeAllForUser(requireNotNull(user.id), now)
        if (user.emailVerifiedAt == null) {
            user.emailVerifiedAt = now
            user.updatedAt = now
            userRepository.save(user)
        }
    }

    /** Always succeeds with a generic outcome to avoid account enumeration. */
    @Transactional
    fun resend(rawEmail: String, clientIp: String) {
        val config = properties.emailVerificationRateLimit
        loginRateLimiter.consume("verify-ip:$clientIp", config.maxAttemptsPerIp, config.window)?.let {
            throw ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many verification requests. Try again later.",
                retryAfterSeconds = it,
            )
        }
        val email = runCatching { validateUserEmail(rawEmail) }.getOrNull() ?: return
        loginRateLimiter.consume("verify-email:$email", config.maxAttemptsPerEmail, config.window)?.let {
            throw ApiException(
                HttpStatus.TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many verification requests. Try again later.",
                retryAfterSeconds = it,
            )
        }
        val user = userRepository.findByEmail(email) ?: return
        if (user.enabled && user.role != UserRole.ADMIN && !user.emailVerified) {
            issueAndSendAfterCommit(user)
        }
    }

    @Transactional
    fun resendForUser(userId: Long) {
        val user = userRepository.findById(userId).orElse(null)
            ?: throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        if (!user.enabled) {
            throw ApiException(HttpStatus.NOT_FOUND, "not_found", "User not found")
        }
        if (user.role == UserRole.ADMIN || user.emailVerified) {
            throw ApiException(HttpStatus.CONFLICT, "already_verified", "User email is already verified")
        }
        if (!properties.emailVerificationRequired) {
            throw ApiException(HttpStatus.CONFLICT, "verification_disabled", "Email verification is not required")
        }
        issueAndSendAfterCommit(user)
    }

    private fun verificationLink(rawToken: String): String {
        val base = properties.publicBaseUrl.trimEnd('/')
        return "$base/verify-email?token=$rawToken"
    }

    private fun afterCommit(action: () -> Unit) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            action()
            return
        }
        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() = action()
            },
        )
    }

    companion object {
        fun hashToken(rawToken: String): String =
            MessageDigest.getInstance("SHA-256")
                .digest(rawToken.toByteArray(StandardCharsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }
}
