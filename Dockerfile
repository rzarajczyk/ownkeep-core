# OwnKeep Core: React SPA + Spring Boot API on one port.
# Postgres remains a separate service.
# Derived SaaS images may overlay /app/extensions/*.jar and /app/static/.
#
# Runtime uses an extracted Boot layout plus an AppCDS archive trained against a
# throwaway Postgres in the cds stage (-XX:SharedArchiveFile on JDK 21).

FROM node:24-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM gradle:8.14.3-jdk21 AS api-build
WORKDIR /workspace
COPY api/gradle gradle
COPY api/gradlew api/gradlew.bat api/settings.gradle.kts api/build.gradle.kts ./
COPY api/src src
COPY --from=web-build /web/dist/ src/main/resources/static/
RUN ./gradlew --no-daemon clean bootJar \
    && cp build/libs/ownkeep-core.jar /workspace/application.jar \
    && java -Djarmode=tools -jar /workspace/application.jar extract --layers --destination /workspace/extracted

# Train AppCDS against local Postgres so Flyway/JPA classes are in the archive.
FROM eclipse-temurin:21-jre AS cds
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql postgresql-contrib \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api-build /workspace/extracted/dependencies/ ./
COPY --from=api-build /workspace/extracted/spring-boot-loader/ ./
COPY --from=api-build /workspace/extracted/snapshot-dependencies/ ./
COPY --from=api-build /workspace/extracted/application/ ./
ENV OWNKEEP_DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/ownkeep \
    OWNKEEP_DATABASE_USER=ownkeep \
    OWNKEEP_DATABASE_PASSWORD=ownkeep \
    OWNKEEP_ATTACHMENT_STORAGE_ROOT=/tmp/ownkeep-attachments \
    OWNKEEP_SPA_STATIC_DIR=/tmp/ownkeep-static
RUN set -eux; \
    mkdir -p /tmp/ownkeep-attachments /tmp/ownkeep-static; \
    PG_VER="$(ls /etc/postgresql)"; \
    PG_CONF="/etc/postgresql/${PG_VER}/main"; \
    echo "listen_addresses = '127.0.0.1'" >> "${PG_CONF}/postgresql.conf"; \
    echo "host all all 127.0.0.1/32 scram-sha-256" >> "${PG_CONF}/pg_hba.conf"; \
    pg_ctlcluster "${PG_VER}" main start; \
    su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE USER ownkeep WITH PASSWORD 'ownkeep' SUPERUSER;\""; \
    su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ownkeep OWNER ownkeep;\""; \
    java -XX:ArchiveClassesAtExit=/app/application.jsa \
      -Dspring.context.exit=onRefresh \
      -jar application.jar; \
    test -s /app/application.jsa; \
    pg_ctlcluster "${PG_VER}" main stop

FROM eclipse-temurin:21-jre
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home ownkeep
WORKDIR /app
COPY --from=cds /app/ /app/
COPY --from=web-build /web/dist/ /app/static/
RUN mkdir -p /data/attachments /app/extensions \
    && chown -R ownkeep:ownkeep /data /app
USER ownkeep
ENV OWNKEEP_ATTACHMENT_STORAGE_ROOT=/data/attachments \
    OWNKEEP_SPA_STATIC_DIR=/app/static \
    LOADER_PATH=/app/extensions
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/health > /dev/null || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-XX:SharedArchiveFile=/app/application.jsa", "-jar", "application.jar"]
