package com.ownkeep.api

import com.zaxxer.hikari.HikariDataSource
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.jdbc.DataSourceUnwrapper
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import javax.sql.DataSource

/**
 * Drops idle Hikari sessions so serverless hosts (Cloud Run + Neon) can scale to zero.
 * Hikari's own idle timeout does not run while Cloud Run has CPU frozen between requests.
 */
@Component
class IdleJdbcConnectionReleaser(private val dataSource: DataSource) {
    fun releaseIdleConnections() {
        val hikari = DataSourceUnwrapper.unwrap(dataSource, HikariDataSource::class.java) ?: return
        hikari.hikariPoolMXBean?.softEvictConnections()
    }
}

@Component
@Order(Ordered.LOWEST_PRECEDENCE)
class ReleaseIdleJdbcConnectionsFilter(
    private val releaser: IdleJdbcConnectionReleaser,
) : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        try {
            filterChain.doFilter(request, response)
        } finally {
            releaser.releaseIdleConnections()
        }
    }
}
