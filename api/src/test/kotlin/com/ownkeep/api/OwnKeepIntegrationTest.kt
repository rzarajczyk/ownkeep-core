package com.ownkeep.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.ownkeep.api.storage.AttachmentBlobStore
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.mock.web.MockMultipartFile
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import java.util.Base64
import java.util.UUID

class OwnKeepPostgres(image: String) : PostgreSQLContainer<OwnKeepPostgres>(image)

@SpringBootTest(
    properties = [
        "ownkeep.admin-email=alice@example.com",
        "ownkeep.admin-password=alice-password",
        "ownkeep.token-ttl=1h",
        "ownkeep.attachment.max-file-size=1024",
        "ownkeep.attachment.per-user-quota=4096",
        "ownkeep.login-rate-limit.max-attempts-per-ip=10000",
        "ownkeep.login-rate-limit.max-attempts-per-email=10000",
    ],
)
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
class OwnKeepIntegrationTest {
    @Autowired
    lateinit var mockMvc: MockMvc

    @Autowired
    lateinit var objectMapper: ObjectMapper

    @Autowired
    lateinit var userRepository: UserRepository

    @Autowired
    lateinit var passwordEncoder: org.springframework.security.crypto.password.PasswordEncoder

    @Autowired
    lateinit var attachmentRepository: AttachmentRepository

    @Autowired
    lateinit var attachmentBlobStore: AttachmentBlobStore

    @Autowired
    lateinit var userManagementService: UserManagementService

    @Autowired
    lateinit var emailVerificationService: EmailVerificationService

    @Autowired
    lateinit var properties: OwnKeepProperties

    @Autowired
    lateinit var transactionManager: org.springframework.transaction.PlatformTransactionManager

    @org.junit.jupiter.api.BeforeEach
    fun ensureBobUser() {
        val existing = userRepository.findByEmail("bob@example.com")
        val now = java.time.Instant.now()
        if (existing == null) {
            userRepository.save(
                UserEntity(
                    email = "bob@example.com",
                    passwordHash = passwordEncoder.encode("bob-password"),
                    enabled = true,
                    role = UserRole.USER,
                    createdAt = now,
                    updatedAt = now,
                ),
            )
        } else {
            existing.enabled = true
            existing.deletedAt = null
            existing.role = UserRole.USER
            existing.recoveryPending = false
            existing.passwordHash = passwordEncoder.encode("bob-password")
            existing.updatedAt = now
            // reset vault between tests
            existing.kdfSalt = null
            existing.kdfParams = null
            existing.wrappedVaultKey = null
            existing.wrappedVaultKeyRecovery = null
            existing.vaultInitializedAt = null
            userRepository.save(existing)
        }
        userRepository.findByEmail("alice@example.com")?.let { alice ->
            alice.enabled = true
            alice.deletedAt = null
            alice.passwordHash = passwordEncoder.encode("alice-password")
            alice.recoveryPending = false
            alice.kdfSalt = null
            alice.kdfParams = null
            alice.wrappedVaultKey = null
            alice.wrappedVaultKeyRecovery = null
            alice.vaultInitializedAt = null
            userRepository.save(alice)
        }
    }

    @Test
    fun `vault init encrypted note ownership and opaque attachment work end to end`() {
        val aliceToken = login("alice@example.com", "alice-password")
        val bobToken = login("bob@example.com", "bob-password")

        mockMvc.perform(get("/me").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.vault.initialized").value(false))

        val salt = b64(ByteArray(16) { 1 })
        val wrap = b64(ByteArray(48) { 2 })
        val recovery = b64(ByteArray(48) { 3 })
        mockMvc.perform(
            post("/me/vault")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "kdfSalt": "$salt",
                      "kdfParams": {"alg":"argon2id","m":65536,"t":3,"p":1},
                      "wrappedVaultKey": "$wrap",
                      "wrappedVaultKeyRecovery": "$recovery"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.initialized").value(true))

        val labelCipher = b64(ByteArray(48) { 4 })
        val labelResult = mockMvc.perform(
            post("/labels")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"ciphertext":"$labelCipher"}"""),
        )
            .andExpect(status().isOk)
            .andReturn()
        val labelId = objectMapper.readTree(labelResult.response.contentAsString).get("id").asText()

        val noteId = UUID.randomUUID()
        val noteCipher = b64(ByteArray(64) { 5 })
        val noteKeyWrap = b64(ByteArray(48) { 6 })
        val createResult = mockMvc.perform(
            post("/notes")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "id": "$noteId",
                      "type": "TEXT",
                      "backgroundColor": "#ffeeaa",
                      "pinned": true,
                      "wrappedNoteKey": "$noteKeyWrap",
                      "ciphertext": "$noteCipher",
                      "labelIds": ["$labelId"]
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.id").value(noteId.toString()))
            .andExpect(jsonPath("$.pinned").value(true))
            .andExpect(jsonPath("$.ciphertext").value(noteCipher))
            .andExpect(jsonPath("$.labelIds[0]").value(labelId))
            .andExpect(jsonPath("$.title").doesNotExist())
            .andReturn()

        val version = objectMapper.readTree(createResult.response.contentAsString).get("version").asLong()

        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $bobToken"))
            .andExpect(status().isNotFound)

        mockMvc.perform(get("/search").header("Authorization", "Bearer $aliceToken").param("q", "x"))
            .andExpect(status().isNotFound)

        mockMvc.perform(get("/markdown/preview").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isNotFound)

        val attachmentId = UUID.randomUUID()
        val meta = b64(ByteArray(48) { 7 })
        mockMvc.perform(
            multipart("/notes/$noteId/attachments")
                .file(MockMultipartFile("file", "secret.bin", "application/octet-stream", ByteArray(16) { 9 }))
                .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                .file(MockMultipartFile("attachmentId", null, "text/plain", attachmentId.toString().toByteArray()))
                .header("Authorization", "Bearer $aliceToken"),
        )
            .andExpect(status().isCreated)
            .andExpect(jsonPath("$.id").value(attachmentId.toString()))
            .andExpect(jsonPath("$.metaCiphertext").value(meta))
            .andExpect(jsonPath("$.originalFilename").doesNotExist())

        mockMvc.perform(get("/attachments/$attachmentId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)

        val afterUpload = mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)
            .andReturn()
        val currentVersion = objectMapper.readTree(afterUpload.response.contentAsString).get("version").asLong()
        assertThat(currentVersion).isGreaterThanOrEqualTo(version)

        mockMvc.perform(
            patch("/notes/$noteId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"version":$currentVersion,"archived":true}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.archived").value(true))
            .andExpect(jsonPath("$.ciphertext").value(noteCipher))

        mockMvc.perform(delete("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isNoContent)

        mockMvc.perform(
            get("/notes")
                .header("Authorization", "Bearer $aliceToken")
                .param("updated_after", "1970-01-01T00:00:00Z"),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.deletedIds[0]").value(noteId.toString()))
    }

    @Test
    fun `password change requires vault wrap and admin reset clears password wrap`() {
        val aliceToken = login("alice@example.com", "alice-password")
        val salt = b64(ByteArray(16) { 1 })
        val wrap = b64(ByteArray(48) { 2 })
        val recovery = b64(ByteArray(48) { 3 })
        mockMvc.perform(
            post("/me/vault")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "kdfSalt": "$salt",
                      "kdfParams": {"alg":"argon2id","m":65536,"t":3,"p":1},
                      "wrappedVaultKey": "$wrap",
                      "wrappedVaultKeyRecovery": "$recovery"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)

        val newWrap = b64(ByteArray(48) { 8 })
        mockMvc.perform(
            patch("/me/password")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "currentPassword":"alice-password",
                      "newPassword":"alice-password-2",
                      "wrappedVaultKey":"$newWrap"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isNoContent)

        val aliceAfter = login("alice@example.com", "alice-password-2")
        val bobToken = login("bob@example.com", "bob-password")
        // promote bob temporarily? alice is admin - reset bob after bob has vault
        val bobWrap = b64(ByteArray(48) { 11 })
        val bobRecovery = b64(ByteArray(48) { 12 })
        mockMvc.perform(
            post("/me/vault")
                .header("Authorization", "Bearer $bobToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "kdfSalt": "$salt",
                      "kdfParams": {"alg":"argon2id","m":65536,"t":3,"p":1},
                      "wrappedVaultKey": "$bobWrap",
                      "wrappedVaultKeyRecovery": "$bobRecovery"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)

        val bobId = userRepository.findByEmail("bob@example.com")!!.id!!
        mockMvc.perform(
            post("/users/$bobId/reset-password")
                .header("Authorization", "Bearer $aliceAfter")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"bob-password-reset"}"""),
        ).andExpect(status().isNoContent)

        val bobAfterReset = login("bob@example.com", "bob-password-reset")
        mockMvc.perform(get("/me").header("Authorization", "Bearer $bobAfterReset"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.vault.needsRecoveryUnlock").value(true))
            .andExpect(jsonPath("$.vault.hasRecoveryKey").value(true))

        val rebound = b64(ByteArray(48) { 13 })
        mockMvc.perform(
            put("/me/vault/wrap")
                .header("Authorization", "Bearer $bobAfterReset")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"wrappedVaultKey":"$rebound"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.needsRecoveryUnlock").value(false))

        assertThat(userRepository.findByEmail("bob@example.com")!!.wrappedVaultKey).isNotNull()
    }

    @Test
    fun `admin user list includes restore metadata in active then deleted order`() {
        val adminToken = login("alice@example.com", "alice-password")
        val suffix = UUID.randomUUID().toString().take(8)
        val activeA = createUser(adminToken, "recovery-$suffix-active-a@example.com")
        val activeZ = createUser(adminToken, "recovery-$suffix-active-z@example.com")
        val deletedA = createUser(adminToken, "recovery-$suffix-deleted-a@example.com")
        val deletedZ = createUser(adminToken, "recovery-$suffix-deleted-z@example.com")

        val deletedAToken = login(deletedA.email, TEST_USER_PASSWORD)
        initializeVault(deletedAToken, 21)
        mockMvc.perform(delete("/users/${deletedA.id}").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(false))
            .andExpect(jsonPath("$.canRestore").value(true))
            .andExpect(jsonPath("$.deletedAt").isString)
        mockMvc.perform(delete("/users/${deletedZ.id}").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.canRestore").value(false))
            .andExpect(jsonPath("$.deletedAt").isString)

        val listResult = mockMvc.perform(get("/users").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
            .andReturn()
        val trackedIds = setOf(activeA.id, activeZ.id, deletedA.id, deletedZ.id)
        val tracked = objectMapper.readTree(listResult.response.contentAsString)
            .filter { it.get("id").asLong() in trackedIds }
        assertThat(tracked.map { it.get("email").asText() }).containsExactly(
            activeA.email,
            activeZ.email,
            deletedA.email,
            deletedZ.email,
        )
        assertThat(tracked.map { it.get("enabled").asBoolean() }).containsExactly(true, true, false, false)
        assertThat(tracked.map { it.get("recoveryPending").asBoolean() })
            .containsExactly(false, false, false, false)
        assertThat(tracked.map { it.get("canRestore").asBoolean() }).containsExactly(false, false, true, false)

        mockMvc.perform(
            post("/users")
                .header("Authorization", "Bearer $adminToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"${deletedZ.email}","password":"$TEST_USER_PASSWORD"}"""),
        )
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("email_taken"))

        mockMvc.perform(post("/users/${activeA.id}/restore").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("user_not_deleted"))
        mockMvc.perform(post("/users/${deletedZ.id}/restore").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("vault_not_initialized"))
        mockMvc.perform(post("/users/${deletedA.id}/restore").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.temporaryPassword").isString)
            .andExpect(jsonPath("$.user.enabled").value(true))
            .andExpect(jsonPath("$.user.recoveryPending").value(true))
            .andExpect(jsonPath("$.user.canRestore").value(false))
        assertThat(userRepository.findById(deletedA.id).orElseThrow().deletedAt).isNull()
    }

    @Test
    fun `self delete soft-deletes account and rejects wrong password and last admin`() {
        val adminToken = login("alice@example.com", "alice-password")
        val suffix = UUID.randomUUID().toString().take(8)
        val user = createUser(adminToken, "self-delete-$suffix@example.com")
        val userToken = login(user.email, TEST_USER_PASSWORD)
        initializeVault(userToken, 51)

        mockMvc.perform(
            delete("/me")
                .header("Authorization", "Bearer $userToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"password":"wrong-password"}"""),
        )
            .andExpect(status().isBadRequest)
            .andExpect(jsonPath("$.code").value("invalid_credentials"))

        mockMvc.perform(
            delete("/me")
                .header("Authorization", "Bearer $userToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"password":"$TEST_USER_PASSWORD"}"""),
        ).andExpect(status().isNoContent)

        val deleted = userRepository.findById(user.id).orElseThrow()
        assertThat(deleted.enabled).isFalse()
        assertThat(deleted.deletedAt).isNotNull()

        mockMvc.perform(get("/me").header("Authorization", "Bearer $userToken"))
            .andExpect(status().isUnauthorized)
        mockMvc.perform(
            post("/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"${user.email}","password":"$TEST_USER_PASSWORD"}"""),
        )
            .andExpect(status().isUnauthorized)

        mockMvc.perform(
            delete("/me")
                .header("Authorization", "Bearer $adminToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"password":"alice-password"}"""),
        )
            .andExpect(status().isBadRequest)
            .andExpect(jsonPath("$.code").value("cannot_delete_last_admin"))
    }

    @Test
    fun `purge removes soft-deleted users past retention and keeps recent ones`() {
        val adminToken = login("alice@example.com", "alice-password")
        val suffix = UUID.randomUUID().toString().take(8)
        val expired = createUser(adminToken, "purge-expired-$suffix@example.com")
        val recent = createUser(adminToken, "purge-recent-$suffix@example.com")
        mockMvc.perform(delete("/users/${expired.id}").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
        mockMvc.perform(delete("/users/${recent.id}").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)

        val expiredUser = userRepository.findById(expired.id).orElseThrow()
        expiredUser.deletedAt = java.time.Instant.now().minus(java.time.Duration.ofDays(61))
        userRepository.save(expiredUser)

        val purged = userManagementService.purgeExpiredDeletedUsers(
            java.time.Instant.now().minus(java.time.Duration.ofDays(60)),
        )
        assertThat(purged).isGreaterThanOrEqualTo(1)
        assertThat(userRepository.findById(expired.id)).isEmpty
        assertThat(userRepository.findById(recent.id)).isPresent
    }

    @Test
    fun `restored user recovery token is isolated and completion preserves encrypted data`() {
        val adminToken = login("alice@example.com", "alice-password")
        val bobToken = login("bob@example.com", "bob-password")
        initializeVault(bobToken, 31)
        val noteId = createEncryptedNote(bobToken, 32)
        val bobId = requireNotNull(userRepository.findByEmail("bob@example.com")?.id)

        mockMvc.perform(delete("/users/$bobId").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $bobToken"))
            .andExpect(status().isUnauthorized)

        val restoreResult = mockMvc.perform(
            post("/users/$bobId/restore").header("Authorization", "Bearer $adminToken"),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.user.recoveryPending").value(true))
            .andReturn()
        val temporaryPassword = objectMapper.readTree(restoreResult.response.contentAsString)
            .get("temporaryPassword")
            .asText()
        assertThat(temporaryPassword).matches("[A-Za-z0-9_-]{43}")

        val recoveryLogin = mockMvc.perform(
            post("/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"bob@example.com","password":"$temporaryPassword"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.recoveryRequired").value(true))
            .andExpect(jsonPath("$.user.vault.initialized").value(true))
            .andExpect(jsonPath("$.user.vault.needsRecoveryUnlock").value(true))
            .andReturn()
        val recoveryToken = objectMapper.readTree(recoveryLogin.response.contentAsString).get("token").asText()

        mockMvc.perform(get("/me").header("Authorization", "Bearer $recoveryToken"))
            .andExpect(status().isUnauthorized)
        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $recoveryToken"))
            .andExpect(status().isUnauthorized)

        val newWrap = b64(ByteArray(48) { 33 })
        mockMvc.perform(
            post("/auth/recovery/complete")
                .header("Authorization", "Bearer $adminToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"not-used","wrappedVaultKey":"$newWrap"}"""),
        )
            .andExpect(status().isUnauthorized)
            .andExpect(jsonPath("$.code").value("invalid_recovery_token"))
        val secondRecoveryToken = login("bob@example.com", temporaryPassword)
        val completion = mockMvc.perform(
            post("/auth/recovery/complete")
                .header("Authorization", "Bearer $recoveryToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "newPassword":"bob-recovered-password",
                      "wrappedVaultKey":"$newWrap"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.recoveryRequired").value(false))
            .andExpect(jsonPath("$.user.vault.wrappedVaultKey").value(newWrap))
            .andReturn()
        val sessionToken = objectMapper.readTree(completion.response.contentAsString).get("token").asText()

        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $sessionToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.id").value(noteId.toString()))
        mockMvc.perform(
            post("/auth/recovery/complete")
                .header("Authorization", "Bearer $secondRecoveryToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"newPassword":"another-password","wrappedVaultKey":"$newWrap"}"""),
        )
            .andExpect(status().isUnauthorized)
            .andExpect(jsonPath("$.code").value("invalid_recovery_token"))
        mockMvc.perform(
            post("/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"bob@example.com","password":"$temporaryPassword"}"""),
        ).andExpect(status().isUnauthorized)

        val normalLogin = mockMvc.perform(
            post("/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"bob@example.com","password":"bob-recovered-password"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.recoveryRequired").value(false))
            .andReturn()
        val normalToken = objectMapper.readTree(normalLogin.response.contentAsString).get("token").asText()
        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $normalToken"))
            .andExpect(status().isOk)

        val bob = userRepository.findByEmail("bob@example.com")!!
        assertThat(bob.recoveryPending).isFalse()
        assertThat(bob.wrappedVaultKey).isEqualTo(ByteArray(48) { 33 })
    }

    @Test
    fun `permanent delete cascades user data and cleans attachment blob after commit`() {
        val adminToken = login("alice@example.com", "alice-password")
        val bobToken = login("bob@example.com", "bob-password")
        val noteId = createEncryptedNote(bobToken, 41)
        val attachmentId = UUID.randomUUID()
        val meta = b64(ByteArray(48) { 42 })
        mockMvc.perform(
            multipart("/notes/$noteId/attachments")
                .file(MockMultipartFile("file", "secret.bin", "application/octet-stream", ByteArray(16) { 43 }))
                .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                .file(MockMultipartFile("attachmentId", null, "text/plain", attachmentId.toString().toByteArray()))
                .header("Authorization", "Bearer $bobToken"),
        ).andExpect(status().isCreated)

        val attachment = attachmentRepository.findById(attachmentId).orElseThrow()
        val storagePath = attachment.storagePath
        assertThat(attachmentBlobStore.exists(storagePath)).isTrue()
        val bobId = requireNotNull(userRepository.findByEmail("bob@example.com")?.id)

        mockMvc.perform(
            delete("/users/$bobId/permanent").header("Authorization", "Bearer $adminToken"),
        )
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("user_not_deleted"))
        mockMvc.perform(delete("/users/$bobId").header("Authorization", "Bearer $adminToken"))
            .andExpect(status().isOk)
        mockMvc.perform(
            delete("/users/$bobId/permanent").header("Authorization", "Bearer $adminToken"),
        ).andExpect(status().isNoContent)

        assertThat(userRepository.findById(bobId)).isEmpty
        assertThat(attachmentRepository.findById(attachmentId)).isEmpty
        assertThat(attachmentBlobStore.exists(storagePath)).isFalse()
    }

    @Test
    fun `api prefix is stripped for health and login`() {
        mockMvc.perform(get("/api/health"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("UP"))

        mockMvc.perform(
            post("/api/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"alice@example.com","password":"alice-password"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.token").isString)
    }

    @Test
    fun `note revisions soft-delete attachments and restore membership`() {
        val aliceToken = login("alice@example.com", "alice-password")
        val bobToken = login("bob@example.com", "bob-password")
        initializeVault(aliceToken, 21)
        val noteId = createEncryptedNote(aliceToken, 21)

        val noteJson = objectMapper.readTree(
            mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        val version = noteJson.get("version").asLong()
        val wrapped = noteJson.get("wrappedNoteKey").asText()
        val cipher = noteJson.get("ciphertext").asText()

        val revisionId = UUID.randomUUID()
        val snapshot = b64(ByteArray(96) { 22 })
        mockMvc.perform(
            post("/notes/$noteId/revisions")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "id": "$revisionId",
                      "sourceVersion": $version,
                      "wrappedNoteKey": "$wrapped",
                      "snapshotCiphertext": "$snapshot"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.created").value(true))
            .andExpect(jsonPath("$.revision.id").value(revisionId.toString()))
            .andExpect(jsonPath("$.revision.labelCiphertext").doesNotExist())

        mockMvc.perform(
            post("/notes/$noteId/revisions")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "id": "${UUID.randomUUID()}",
                      "sourceVersion": $version,
                      "wrappedNoteKey": "$wrapped",
                      "snapshotCiphertext": "$snapshot"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.created").value(false))
            .andExpect(jsonPath("$.revision.id").value(revisionId.toString()))

        mockMvc.perform(
            patch("/notes/$noteId/revisions/$revisionId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"label":"secret"}"""),
        )
            .andExpect(status().isBadRequest)

        val labelCipher = b64(ByteArray(48) { 23 })
        mockMvc.perform(
            patch("/notes/$noteId/revisions/$revisionId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"labelCiphertext":"$labelCipher"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.labelCiphertext").value(labelCipher))

        mockMvc.perform(get("/notes/$noteId/revisions").header("Authorization", "Bearer $bobToken"))
            .andExpect(status().isNotFound)

        val attachmentId = UUID.randomUUID()
        val meta = b64(ByteArray(48) { 24 })
        mockMvc.perform(
            multipart("/notes/$noteId/attachments")
                .file(MockMultipartFile("file", "secret.bin", "application/octet-stream", ByteArray(16) { 25 }))
                .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                .file(MockMultipartFile("attachmentId", null, "text/plain", attachmentId.toString().toByteArray()))
                .header("Authorization", "Bearer $aliceToken"),
        )
            .andExpect(status().isCreated)

        val afterUpload = objectMapper.readTree(
            mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andExpect(jsonPath("$.attachments.length()").value(1))
                .andReturn()
                .response
                .contentAsString,
        )
        assertThat(afterUpload.get("version").asLong()).isGreaterThanOrEqualTo(version)

        mockMvc.perform(delete("/attachments/$attachmentId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isNoContent)

        mockMvc.perform(get("/attachments/$attachmentId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isNotFound)

        mockMvc.perform(
            get("/notes/$noteId/retained-attachments/$attachmentId")
                .header("Authorization", "Bearer $aliceToken"),
        )
            .andExpect(status().isOk)

        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.attachments.length()").value(0))

        val afterDelete = objectMapper.readTree(
            mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        val versionAfterDelete = afterDelete.get("version").asLong()

        val undoId = UUID.randomUUID()
        val restoredCipher = b64(ByteArray(64) { 26 })
        val restoredWrap = b64(ByteArray(48) { 27 })
        mockMvc.perform(
            post("/notes/$noteId/revisions/$revisionId/restore")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "expectedVersion": $versionAfterDelete,
                      "undoRevision": {
                        "id": "$undoId",
                        "sourceVersion": $versionAfterDelete,
                        "wrappedNoteKey": "$wrapped",
                        "snapshotCiphertext": "${b64(ByteArray(80) { 28 })}"
                      },
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "archived": false,
                      "pinned": true,
                      "wrappedNoteKey": "$restoredWrap",
                      "ciphertext": "$restoredCipher",
                      "labelIds": [],
                      "attachmentIds": ["$attachmentId"]
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.note.pinned").value(true))
            .andExpect(jsonPath("$.note.ciphertext").value(restoredCipher))
            .andExpect(jsonPath("$.note.attachments.length()").value(1))
            .andExpect(jsonPath("$.note.attachments[0].id").value(attachmentId.toString()))
            .andExpect(jsonPath("$.unavailableAttachmentIds").isEmpty)

        mockMvc.perform(get("/attachments/$attachmentId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)
    }

    @Test
    fun `conflict-resolve keeps matching version as local winner without revisions`() {
        val aliceToken = login("alice@example.com", "alice-password")
        initializeVault(aliceToken, 61)
        val noteId = createEncryptedNote(aliceToken, 61)

        val noteJson = objectMapper.readTree(
            mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        val version = noteJson.get("version").asLong()
        val clientUpdatedAt = noteJson.get("clientUpdatedAt").asText()

        val newCipher = b64(ByteArray(64) { 62 })
        val newWrap = b64(ByteArray(48) { 63 })
        val localSnap = b64(ByteArray(48) { 64 })
        val remoteSnap = b64(ByteArray(48) { 65 })
        val resolveResult = mockMvc.perform(
            post("/notes/$noteId/conflict-resolve")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "version": $version,
                      "localRevisionId": "${UUID.randomUUID()}",
                      "remoteRevisionId": "${UUID.randomUUID()}",
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "archived": false,
                      "pinned": false,
                      "wrappedNoteKey": "$newWrap",
                      "ciphertext": "$newCipher",
                      "localSnapshotCiphertext": "$localSnap",
                      "remoteSnapshotCiphertext": "$remoteSnap",
                      "labelIds": [],
                      "clientUpdatedAt": "$clientUpdatedAt",
                      "clientMutationId": "match-version-mut"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.winner").value("local"))
            .andExpect(jsonPath("$.note.ciphertext").value(newCipher))
            .andExpect(jsonPath("$.localRevision").doesNotExist())
            .andExpect(jsonPath("$.remoteRevision").doesNotExist())
    }

    @Test
    fun `conflict-resolve records revisions and picks LWW winner when versions differ`() {
        val aliceToken = login("alice@example.com", "alice-password")
        initializeVault(aliceToken, 71)

        val localWinsNoteId = createEncryptedNote(aliceToken, 71)
        val localWinsNote = objectMapper.readTree(
            mockMvc.perform(get("/notes/$localWinsNoteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        val staleVersionLocal = localWinsNote.get("version").asLong()
        val remoteCipherLocalCase = b64(ByteArray(64) { 72 })
        val remoteWrapLocalCase = b64(ByteArray(48) { 73 })
        val t1 = "2026-06-01T10:00:00Z"
        val t2 = "2026-06-01T11:00:00Z"
        mockMvc.perform(
            patch("/notes/$localWinsNoteId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "version": $staleVersionLocal,
                      "wrappedNoteKey": "$remoteWrapLocalCase",
                      "ciphertext": "$remoteCipherLocalCase",
                      "clientUpdatedAt": "$t1",
                      "clientMutationId": "remote-mut"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)

        val localCipher = b64(ByteArray(64) { 74 })
        val localWrap = b64(ByteArray(48) { 75 })
        val localSnap = b64(ByteArray(48) { 76 })
        val remoteSnap = b64(ByteArray(48) { 77 })
        mockMvc.perform(
            post("/notes/$localWinsNoteId/conflict-resolve")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "version": $staleVersionLocal,
                      "localRevisionId": "${UUID.randomUUID()}",
                      "remoteRevisionId": "${UUID.randomUUID()}",
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "archived": false,
                      "pinned": false,
                      "wrappedNoteKey": "$localWrap",
                      "ciphertext": "$localCipher",
                      "localSnapshotCiphertext": "$localSnap",
                      "remoteSnapshotCiphertext": "$remoteSnap",
                      "labelIds": [],
                      "clientUpdatedAt": "$t2",
                      "clientMutationId": "local-mut"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.winner").value("local"))
            .andExpect(jsonPath("$.note.ciphertext").value(localCipher))
            .andExpect(jsonPath("$.localRevision.origin").value("CONFLICT_LOCAL"))
            .andExpect(jsonPath("$.remoteRevision.origin").value("CONFLICT_REMOTE"))

        val remoteWinsNoteId = createEncryptedNote(aliceToken, 78)
        val remoteWinsNote = objectMapper.readTree(
            mockMvc.perform(get("/notes/$remoteWinsNoteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        val staleVersionRemote = remoteWinsNote.get("version").asLong()
        val remoteCipherRemoteCase = b64(ByteArray(64) { 79 })
        val remoteWrapRemoteCase = b64(ByteArray(48) { 80 })
        mockMvc.perform(
            patch("/notes/$remoteWinsNoteId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "version": $staleVersionRemote,
                      "wrappedNoteKey": "$remoteWrapRemoteCase",
                      "ciphertext": "$remoteCipherRemoteCase",
                      "clientUpdatedAt": "$t1",
                      "clientMutationId": "remote-mut"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)

        val olderLocalCipher = b64(ByteArray(64) { 81 })
        mockMvc.perform(
            post("/notes/$remoteWinsNoteId/conflict-resolve")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "version": $staleVersionRemote,
                      "localRevisionId": "${UUID.randomUUID()}",
                      "remoteRevisionId": "${UUID.randomUUID()}",
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "archived": false,
                      "pinned": false,
                      "wrappedNoteKey": "${b64(ByteArray(48) { 82 })}",
                      "ciphertext": "$olderLocalCipher",
                      "localSnapshotCiphertext": "${b64(ByteArray(48) { 83 })}",
                      "remoteSnapshotCiphertext": "${b64(ByteArray(48) { 84 })}",
                      "labelIds": [],
                      "clientUpdatedAt": "2026-06-01T09:00:00Z",
                      "clientMutationId": "older-local-mut"
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.winner").value("remote"))
            .andExpect(jsonPath("$.note.ciphertext").value(remoteCipherRemoteCase))
            .andExpect(jsonPath("$.localRevision.origin").value("CONFLICT_LOCAL"))
            .andExpect(jsonPath("$.remoteRevision.origin").value("CONFLICT_REMOTE"))
    }

    @Test
    fun `note patch rejects stale version`() {
        val aliceToken = login("alice@example.com", "alice-password")
        initializeVault(aliceToken, 91)
        val noteId = createEncryptedNote(aliceToken, 91)
        val version = objectMapper.readTree(
            mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        ).get("version").asLong()

        mockMvc.perform(
            patch("/notes/$noteId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"version":${version + 1},"archived":true}"""),
        )
            .andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("version_conflict"))
    }

    @Test
    fun `labels list update and delete cascade note membership`() {
        val aliceToken = login("alice@example.com", "alice-password")
        initializeVault(aliceToken, 101)

        val labelCipher = b64(ByteArray(48) { 102 })
        val labelResult = mockMvc.perform(
            post("/labels")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"ciphertext":"$labelCipher"}"""),
        )
            .andExpect(status().isOk)
            .andReturn()
        val labelId = objectMapper.readTree(labelResult.response.contentAsString).get("id").asText()

        val listed = objectMapper.readTree(
            mockMvc.perform(get("/labels").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        assertThat(listed.map { it.get("id").asText() }).contains(labelId)
        assertThat(listed.first { it.get("id").asText() == labelId }.get("ciphertext").asText()).isEqualTo(labelCipher)

        val updatedCipher = b64(ByteArray(48) { 103 })
        mockMvc.perform(
            patch("/labels/$labelId")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"ciphertext":"$updatedCipher"}"""),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.ciphertext").value(updatedCipher))

        val noteId = UUID.randomUUID()
        mockMvc.perform(
            post("/notes")
                .header("Authorization", "Bearer $aliceToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "id": "$noteId",
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "pinned": false,
                      "wrappedNoteKey": "${b64(ByteArray(48) { 104 })}",
                      "ciphertext": "${b64(ByteArray(64) { 104 })}",
                      "labelIds": ["$labelId"]
                    }
                    """.trimIndent(),
                ),
        )
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.labelIds[0]").value(labelId))

        mockMvc.perform(delete("/labels/$labelId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isNoContent)

        mockMvc.perform(get("/notes/$noteId").header("Authorization", "Bearer $aliceToken"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.labelIds").isEmpty)

        val labels = objectMapper.readTree(
            mockMvc.perform(get("/labels").header("Authorization", "Bearer $aliceToken"))
                .andExpect(status().isOk)
                .andReturn()
                .response
                .contentAsString,
        )
        assertThat(labels.map { it.get("id").asText() }).doesNotContain(labelId)
    }

    @Test
    fun `logout revokes the session token`() {
        val token = login("alice@example.com", "alice-password")
        mockMvc.perform(get("/me").header("Authorization", "Bearer $token"))
            .andExpect(status().isOk)

        mockMvc.perform(post("/auth/logout").header("Authorization", "Bearer $token"))
            .andExpect(status().isNoContent)

        mockMvc.perform(get("/me").header("Authorization", "Bearer $token"))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `email verification confirm unlocks login when required`() {
        val adminToken = login("alice@example.com", "alice-password")
        val suffix = UUID.randomUUID().toString().take(8)
        val user = createUser(adminToken, "verify-$suffix@example.com")
        val entity = userRepository.findById(user.id).orElseThrow()
        entity.emailVerifiedAt = null
        userRepository.save(entity)

        val previousRequired = properties.emailVerificationRequired
        properties.emailVerificationRequired = true
        try {
            mockMvc.perform(
                post("/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""{"email":"${user.email}","password":"$TEST_USER_PASSWORD"}"""),
            )
                .andExpect(status().isForbidden)
                .andExpect(jsonPath("$.code").value("email_not_verified"))

            val rawToken = org.springframework.transaction.support.TransactionTemplate(transactionManager).execute {
                emailVerificationService.createToken(user.id)
            }!!

            mockMvc.perform(
                post("/auth/email/verify")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""{"token":"$rawToken"}"""),
            ).andExpect(status().isNoContent)

            mockMvc.perform(
                post("/auth/login")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""{"email":"${user.email}","password":"$TEST_USER_PASSWORD"}"""),
            )
                .andExpect(status().isOk)
                .andExpect(jsonPath("$.token").isString)

            mockMvc.perform(
                post("/auth/email/resend")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""{"email":"${user.email}"}"""),
            )
                .andExpect(status().isOk)
                .andExpect(jsonPath("$.message").isString)
        } finally {
            properties.emailVerificationRequired = previousRequired
        }
    }

    @Test
    fun `attachment upload rejects oversize and quota`() {
        val aliceToken = login("alice@example.com", "alice-password")
        initializeVault(aliceToken, 111)
        val noteId = createEncryptedNote(aliceToken, 111)
        val meta = b64(ByteArray(48) { 112 })

        mockMvc.perform(
            multipart("/notes/$noteId/attachments")
                .file(MockMultipartFile("file", "big.bin", "application/octet-stream", ByteArray(1025) { 1 }))
                .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                .file(MockMultipartFile("attachmentId", null, "text/plain", UUID.randomUUID().toString().toByteArray()))
                .header("Authorization", "Bearer $aliceToken"),
        )
            .andExpect(status().isPayloadTooLarge)
            .andExpect(jsonPath("$.code").value("file_too_large"))

        repeat(4) { index ->
            mockMvc.perform(
                multipart("/notes/$noteId/attachments")
                    .file(MockMultipartFile("file", "chunk-$index.bin", "application/octet-stream", ByteArray(900) { index.toByte() }))
                    .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                    .file(MockMultipartFile("attachmentId", null, "text/plain", UUID.randomUUID().toString().toByteArray()))
                    .header("Authorization", "Bearer $aliceToken"),
            ).andExpect(status().isCreated)
        }

        mockMvc.perform(
            multipart("/notes/$noteId/attachments")
                .file(MockMultipartFile("file", "over-quota.bin", "application/octet-stream", ByteArray(900) { 9 }))
                .file(MockMultipartFile("metaCiphertext", null, "text/plain", meta.toByteArray()))
                .file(MockMultipartFile("attachmentId", null, "text/plain", UUID.randomUUID().toString().toByteArray()))
                .header("Authorization", "Bearer $aliceToken"),
        )
            .andExpect(status().isPayloadTooLarge)
            .andExpect(jsonPath("$.code").value("quota_exceeded"))
    }

    private fun login(email: String, password: String): String {
        val result = mockMvc.perform(
            post("/auth/login")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$password"}"""),
        )
            .andExpect(status().isOk)
            .andReturn()
        return objectMapper.readTree(result.response.contentAsString).get("token").asText()
    }

    private fun createUser(adminToken: String, email: String): CreatedUser {
        val result = mockMvc.perform(
            post("/users")
                .header("Authorization", "Bearer $adminToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"email":"$email","password":"$TEST_USER_PASSWORD"}"""),
        )
            .andExpect(status().isOk)
            .andReturn()
        val response = objectMapper.readTree(result.response.contentAsString)
        return CreatedUser(response.get("id").asLong(), response.get("email").asText())
    }

    private fun initializeVault(token: String, marker: Byte) {
        mockMvc.perform(
            post("/me/vault")
                .header("Authorization", "Bearer $token")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "kdfSalt": "${b64(ByteArray(16) { marker })}",
                      "kdfParams": {"alg":"argon2id","m":65536,"t":3,"p":1},
                      "wrappedVaultKey": "${b64(ByteArray(48) { marker })}",
                      "wrappedVaultKeyRecovery": "${b64(ByteArray(48) { (marker + 1).toByte() })}"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)
    }

    private fun createEncryptedNote(token: String, marker: Byte): UUID {
        val noteId = UUID.randomUUID()
        mockMvc.perform(
            post("/notes")
                .header("Authorization", "Bearer $token")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "id": "$noteId",
                      "type": "TEXT",
                      "backgroundColor": "default",
                      "pinned": false,
                      "wrappedNoteKey": "${b64(ByteArray(48) { marker })}",
                      "ciphertext": "${b64(ByteArray(64) { marker })}",
                      "labelIds": []
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isOk)
        return noteId
    }

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    private data class CreatedUser(val id: Long, val email: String)

    companion object {
        private const val TEST_USER_PASSWORD = "recovery-test-password"

        @Container
        @JvmStatic
        val postgres = OwnKeepPostgres("postgres:16-alpine")

        @JvmStatic
        @DynamicPropertySource
        fun datasource(registry: DynamicPropertyRegistry) {
            registry.add("spring.datasource.url", postgres::getJdbcUrl)
            registry.add("spring.datasource.username", postgres::getUsername)
            registry.add("spring.datasource.password", postgres::getPassword)
            registry.add("ownkeep.attachment.storage-root") {
                java.nio.file.Files.createTempDirectory("ownkeep-att").toString()
            }
        }
    }
}
