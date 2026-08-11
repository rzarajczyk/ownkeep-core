package com.ownkeep.api

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64

class CoreUnitTests {
    @Test
    fun `crypto support round trips base64`() {
        val bytes = ByteArray(32) { it.toByte() }
        val encoded = CryptoSupport.encode(bytes)
        assertThat(CryptoSupport.decodeRequired(encoded, "field")).isEqualTo(bytes)
    }

    @Test
    fun `crypto support rejects invalid base64`() {
        assertThatThrownBy { CryptoSupport.decodeRequired("%%%", "field") }
            .isInstanceOf(ApiException::class.java)
    }

    @Test
    fun `kdf params validation accepts argon2id defaults`() {
        AuthService.validateKdfParams(KdfParamsDto(alg = "argon2id", m = 65536, t = 3, p = 1))
    }

    @Test
    fun `kdf params validation rejects bad algorithm`() {
        assertThatThrownBy {
            AuthService.validateKdfParams(KdfParamsDto(alg = "pbkdf2", m = 65536, t = 3, p = 1))
        }.isInstanceOf(ApiException::class.java)
    }

    @Test
    fun `login rate limiter blocks after max attempts`() {
        var now = Instant.parse("2026-01-01T00:00:00Z")
        val clock = Clock.fixed(now, ZoneOffset.UTC)
        val limiter = LoginRateLimiter(
            OwnKeepProperties(
                loginRateLimit = OwnKeepProperties.LoginRateLimitProperties(
                    maxAttemptsPerIp = 3,
                    maxAttemptsPerEmail = 100,
                    window = Duration.ofMinutes(1),
                ),
            ),
            clock,
        )
        repeat(3) { limiter.check("1.2.3.4", "alice") }
        assertThatThrownBy { limiter.check("1.2.3.4", "alice") }
            .isInstanceOf(ApiException::class.java)
            .extracting("status")
            .isEqualTo(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS)
    }

    @Test
    fun `wrapped vault payload must be long enough for aes-gcm blob`() {
        val short = Base64.getEncoder().encodeToString(ByteArray(8))
        assertThatThrownBy { CryptoSupport.decodeRequired(short, "wrappedVaultKey", minBytes = 28) }
            .isInstanceOf(ApiException::class.java)
    }

    @Test
    fun `localWins prefers newer clientUpdatedAt then lexicographic mutation id`() {
        val earlier = Instant.parse("2026-01-01T00:00:00Z")
        val later = Instant.parse("2026-01-01T00:00:01Z")
        assertThat(localWins(later, "a", earlier, "z")).isTrue()
        assertThat(localWins(earlier, "z", later, "a")).isFalse()
        assertThat(localWins(earlier, "b", earlier, "a")).isTrue()
        assertThat(localWins(earlier, "a", earlier, "b")).isFalse()
        assertThat(localWins(earlier, "a", earlier, null)).isTrue()
    }
}
