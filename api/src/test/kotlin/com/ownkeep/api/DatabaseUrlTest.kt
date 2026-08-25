package com.ownkeep.api

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.boot.SpringApplication
import org.springframework.mock.env.MockEnvironment

class DatabaseUrlTest {
    @Test
    fun `parses neon postgresql uri`() {
        val parsed = DatabaseUrls.parse(
            "postgresql://neondb_owner:npg_secret%21@ep-foo.eu-central-1.aws.neon.tech/neondb?sslmode=require",
        )
        assertThat(parsed.jdbcUrl)
            .isEqualTo("jdbc:postgresql://ep-foo.eu-central-1.aws.neon.tech/neondb?sslmode=require")
        assertThat(parsed.username).isEqualTo("neondb_owner")
        assertThat(parsed.password).isEqualTo("npg_secret!")
    }

    @Test
    fun `preserves neon query options and maps channel_binding for JDBC`() {
        val parsed = DatabaseUrls.parse(
            "postgresql://neondb_owner:password@ep-square-forest-b1yve61q-pooler.c-5.eu-central-1.aws.neon.tech/ownkeep-main?sslmode=require&channel_binding=require",
        )
        assertThat(parsed.username).isEqualTo("neondb_owner")
        assertThat(parsed.password).isEqualTo("password")
        assertThat(parsed.jdbcUrl).isEqualTo(
            "jdbc:postgresql://ep-square-forest-b1yve61q-pooler.c-5.eu-central-1.aws.neon.tech/ownkeep-main?sslmode=require&channelBinding=require",
        )
    }

    @Test
    fun `parses local compose uri`() {
        val parsed = DatabaseUrls.parse("postgresql://ownkeep:s3cret@db:5432/ownkeep")
        assertThat(parsed.jdbcUrl).isEqualTo("jdbc:postgresql://db:5432/ownkeep")
        assertThat(parsed.username).isEqualTo("ownkeep")
        assertThat(parsed.password).isEqualTo("s3cret")
    }

    @Test
    fun `passes through jdbc url without embedded credentials`() {
        val parsed = DatabaseUrls.parse("jdbc:postgresql://localhost:5432/ownkeep")
        assertThat(parsed.jdbcUrl).isEqualTo("jdbc:postgresql://localhost:5432/ownkeep")
        assertThat(parsed.username).isNull()
        assertThat(parsed.password).isNull()
    }

    @Test
    fun `rejects unsupported schemes`() {
        assertThatThrownBy { DatabaseUrls.parse("mysql://localhost/db") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `post processor fails fast on invalid OWNKEEP_DATABASE_URL`() {
        val env = MockEnvironment()
        env.setProperty("OWNKEEP_DATABASE_URL", "mysql://localhost/db")
        assertThatThrownBy {
            DatabaseUrlEnvironmentPostProcessor().postProcessEnvironment(env, SpringApplication())
        }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining("Invalid database URL")
    }

    @Test
    fun `post processor is registered in spring factories`() {
        val resource = javaClass.classLoader.getResource("META-INF/spring.factories")
            ?: error("META-INF/spring.factories is missing from the classpath")
        assertThat(resource.readText())
            .contains(DatabaseUrlEnvironmentPostProcessor::class.java.name)
    }

    @Test
    fun `post processor applies neon uri credentials`() {
        val env = MockEnvironment()
        env.setProperty(
            "OWNKEEP_DATABASE_URL",
            "postgresql://neondb_owner:npg_secret%21@ep-foo.eu-central-1.aws.neon.tech/neondb?sslmode=require",
        )
        DatabaseUrlEnvironmentPostProcessor().postProcessEnvironment(env, SpringApplication())
        assertThat(env.getProperty("spring.datasource.url"))
            .isEqualTo("jdbc:postgresql://ep-foo.eu-central-1.aws.neon.tech/neondb?sslmode=require")
        assertThat(env.getProperty("spring.datasource.username")).isEqualTo("neondb_owner")
        assertThat(env.getProperty("spring.datasource.password")).isEqualTo("npg_secret!")
    }
}
