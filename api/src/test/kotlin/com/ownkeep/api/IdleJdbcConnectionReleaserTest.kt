package com.ownkeep.api

import com.zaxxer.hikari.HikariDataSource
import com.zaxxer.hikari.HikariPoolMXBean
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.springframework.http.HttpStatus
import javax.sql.DataSource

class HealthControllerTest {
    @Test
    fun `reports up without querying the database`() {
        val response = HealthController().health()
        assertThat(response.statusCode).isEqualTo(HttpStatus.OK)
        assertThat(response.body).isEqualTo(mapOf("status" to "UP"))
    }
}

class IdleJdbcConnectionReleaserTest {
    @Test
    fun `soft-evicts idle hikari connections`() {
        val pool = mock<HikariPoolMXBean>()
        val hikari = mock<HikariDataSource>()
        whenever(hikari.hikariPoolMXBean).thenReturn(pool)

        IdleJdbcConnectionReleaser(hikari).releaseIdleConnections()

        verify(pool).softEvictConnections()
    }

    @Test
    fun `ignores non-hikari data sources`() {
        IdleJdbcConnectionReleaser(mock<DataSource>()).releaseIdleConnections()
    }
}
