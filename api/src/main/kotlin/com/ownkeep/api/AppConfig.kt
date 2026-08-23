package com.ownkeep.api

import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.mail.javamail.JavaMailSender
import org.springframework.scheduling.annotation.EnableAsync
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter
import java.nio.file.Path
import java.time.Duration

@ConfigurationProperties("ownkeep")
data class OwnKeepProperties(
    var adminEmail: String = "",
    var adminPassword: String = "",
    var tokenTtl: Duration = Duration.ofDays(30),
    /** How long soft-deleted accounts are retained before permanent purge. */
    var deletedUserRetention: Duration = Duration.ofDays(60),
    /** How long note revisions and retained soft-deleted attachments are kept. */
    var noteRevisionRetention: Duration = Duration.ofDays(30),
    var maxSyncLimit: Int = 200,
    var emailVerificationRequired: Boolean = false,
    var publicBaseUrl: String = "",
    var emailVerificationTokenTtl: Duration = Duration.ofHours(24),
    var emailVerificationRateLimit: EmailVerificationRateLimitProperties = EmailVerificationRateLimitProperties(),
    var loginRateLimit: LoginRateLimitProperties = LoginRateLimitProperties(),
    var mail: MailProperties = MailProperties(),
    var spaStaticDir: Path? = null,
    var attachment: AttachmentProperties = AttachmentProperties(),
    var takeoutImport: TakeoutImportProperties = TakeoutImportProperties(),
) {
    data class LoginRateLimitProperties(
        /** Max login attempts per client IP within [window]. */
        var maxAttemptsPerIp: Int = 10,
        /** Max login attempts per email within [window]. */
        var maxAttemptsPerEmail: Int = 5,
        var window: Duration = Duration.ofMinutes(1),
    )

    data class EmailVerificationRateLimitProperties(
        var maxAttemptsPerIp: Int = 10,
        var maxAttemptsPerEmail: Int = 5,
        var window: Duration = Duration.ofMinutes(1),
    )

    data class MailProperties(
        var host: String = "",
        var port: Int = 587,
        var username: String = "",
        var password: String = "",
        var smtpAuth: Boolean = true,
        var startTls: Boolean = true,
        var from: String = "",
    )

    data class AttachmentProperties(
        /** filesystem (default) or gcs */
        var storage: String = "filesystem",
        var storageRoot: Path = Path.of("./data/attachments"),
        var maxFileSize: Long = 25L * 1024 * 1024,
        var perUserQuota: Long = 1024L * 1024 * 1024,
        var gcs: GcsAttachmentProperties = GcsAttachmentProperties(),
    )

    data class GcsAttachmentProperties(
        var bucket: String = "",
        var prefix: String = "",
    )

    data class TakeoutImportProperties(
        var stagingRoot: Path? = null,
        var maxUploadSize: Long = 100L * 1024 * 1024,
        var maxEntries: Int = 5_000,
        var maxEntrySize: Long = 50L * 1024 * 1024,
        var maxUncompressedSize: Long = 500L * 1024 * 1024,
        var maxWarnings: Int = 100,
    )
}

@Configuration
@EnableMethodSecurity
@EnableAsync
class AppConfig {
    @Bean
    fun passwordEncoder(): PasswordEncoder = BCryptPasswordEncoder(12)

    @Bean
    fun loginRateLimiter(properties: OwnKeepProperties) = LoginRateLimiter(properties)

    @Bean
    fun emailDeliveryService(
        properties: OwnKeepProperties,
        mailSender: ObjectProvider<JavaMailSender>,
    ) = EmailDeliveryService(properties, mailSender.ifAvailable)

    @Bean
    fun securityFilterChain(
        http: HttpSecurity,
        tokenAuthenticationFilter: TokenAuthenticationFilter,
        apiAuthenticationEntryPoint: ApiAuthenticationEntryPoint,
        apiAccessDeniedHandler: ApiAccessDeniedHandler,
        publicEndpointContributors: List<PublicEndpointContributor>,
    ): SecurityFilterChain {
        val extensionRegistry = PublicEndpointRegistry()
        publicEndpointContributors.forEach { it.contribute(extensionRegistry) }

        http
            .csrf { it.disable() }
            .headers {
                it.contentSecurityPolicy { csp ->
                    csp.policyDirectives(
                        "default-src 'self'; " +
                            "base-uri 'self'; " +
                            "connect-src 'self'; " +
                            "font-src 'self'; " +
                            "frame-ancestors 'self'; " +
                            "img-src 'self' blob: data:; " +
                            "object-src 'none'; " +
                            "script-src 'self' 'wasm-unsafe-eval'; " +
                            "style-src 'self' 'unsafe-inline'; " +
                            "worker-src 'self'",
                    )
                }
            }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .exceptionHandling {
                it.authenticationEntryPoint(apiAuthenticationEntryPoint)
                it.accessDeniedHandler(apiAccessDeniedHandler)
            }
            .authorizeHttpRequests {
                it.requestMatchers(
                    HttpMethod.POST,
                    "/auth/login",
                    "/auth/recovery/complete",
                    "/auth/email/verify",
                    "/auth/email/resend",
                ).permitAll()
                extensionRegistry.postPaths.forEach { path ->
                    it.requestMatchers(HttpMethod.POST, path).permitAll()
                }
                extensionRegistry.getPaths.forEach { path ->
                    it.requestMatchers(HttpMethod.GET, path).permitAll()
                }
                extensionRegistry.anyPaths.forEach { path ->
                    it.requestMatchers(path).permitAll()
                }
                it.requestMatchers("/health", "/actuator/health", "/openapi.json").permitAll()
                // SPA shell and Vite-hashed assets (unified image serves UI from Spring).
                it.requestMatchers("/", "/index.html", "/assets/**", "/favicon.ico", "/verify-email").permitAll()
                it.requestMatchers(
                    HttpMethod.GET,
                    "/*.js",
                    "/*.css",
                    "/*.map",
                    "/*.svg",
                    "/*.png",
                    "/*.ico",
                    "/*.webp",
                    "/*.woff",
                    "/*.woff2",
                    "/*.ttf",
                ).permitAll()
                it.anyRequest().authenticated()
            }
            .addFilterBefore(tokenAuthenticationFilter, UsernamePasswordAuthenticationFilter::class.java)
        return http.build()
    }
}
