package com.ownkeep.api

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.persistence.OptimisticLockException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.ConstraintViolationException
import org.slf4j.LoggerFactory
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.orm.ObjectOptimisticLockingFailureException
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.stereotype.Component
import org.springframework.validation.BindException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.MissingServletRequestParameterException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.multipart.MaxUploadSizeExceededException
import org.springframework.web.multipart.support.MissingServletRequestPartException
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import org.springframework.web.servlet.resource.NoResourceFoundException
import java.time.Instant

class ApiException(
    val status: HttpStatus,
    val code: String,
    override val message: String,
    val retryAfterSeconds: Long? = null,
) : RuntimeException(message)

data class ApiError(
    val timestamp: Instant = Instant.now(),
    val status: Int,
    val code: String,
    val message: String,
    val path: String,
    val fieldErrors: Map<String, String>? = null,
)

@Component
class ApiAuthenticationEntryPoint(private val objectMapper: ObjectMapper) : AuthenticationEntryPoint {
    override fun commence(
        request: HttpServletRequest,
        response: HttpServletResponse,
        authException: AuthenticationException,
    ) {
        writeError(response, request.requestURI, HttpStatus.UNAUTHORIZED, "unauthorized", "Authentication required")
    }

    private fun writeError(
        response: HttpServletResponse,
        path: String,
        status: HttpStatus,
        code: String,
        message: String,
    ) {
        response.status = status.value()
        response.contentType = "application/json"
        objectMapper.writeValue(response.outputStream, ApiError(status = status.value(), code = code, message = message, path = path))
    }
}

@Component
class ApiAccessDeniedHandler(private val objectMapper: ObjectMapper) : AccessDeniedHandler {
    override fun handle(
        request: HttpServletRequest,
        response: HttpServletResponse,
        accessDeniedException: AccessDeniedException,
    ) {
        response.status = HttpStatus.FORBIDDEN.value()
        response.contentType = "application/json"
        objectMapper.writeValue(
            response.outputStream,
            ApiError(
                status = HttpStatus.FORBIDDEN.value(),
                code = "forbidden",
                message = "Access denied",
                path = request.requestURI,
            ),
        )
    }
}

@RestControllerAdvice
class ApiExceptionHandler {
    private val logger = LoggerFactory.getLogger(javaClass)

    @ExceptionHandler(ApiException::class)
    fun api(ex: ApiException, request: HttpServletRequest): ResponseEntity<ApiError> {
        val builder = ResponseEntity.status(ex.status)
        ex.retryAfterSeconds?.let { builder.header(HttpHeaders.RETRY_AFTER, it.toString()) }
        return builder.body(
            ApiError(
                status = ex.status.value(),
                code = ex.code,
                message = ex.message,
                path = request.requestURI,
            ),
        )
    }

    @ExceptionHandler(MethodArgumentNotValidException::class, BindException::class)
    fun validation(ex: Exception, request: HttpServletRequest): ResponseEntity<ApiError> {
        val result = when (ex) {
            is MethodArgumentNotValidException -> ex.bindingResult
            is BindException -> ex.bindingResult
            else -> error("Unexpected validation exception")
        }
        val fields = result.fieldErrors.associate { it.field to (it.defaultMessage ?: "Invalid value") }
        return response(HttpStatus.BAD_REQUEST, "validation_failed", "Request validation failed", request.requestURI, fields)
    }

    @ExceptionHandler(MissingServletRequestParameterException::class)
    fun missingParameter(ex: MissingServletRequestParameterException, request: HttpServletRequest) =
        response(HttpStatus.BAD_REQUEST, "missing_parameter", "${ex.parameterName} is required", request.requestURI)

    @ExceptionHandler(MissingServletRequestPartException::class)
    fun missingPart(ex: MissingServletRequestPartException, request: HttpServletRequest) =
        response(HttpStatus.BAD_REQUEST, "missing_part", "${ex.requestPartName} is required", request.requestURI)

    @ExceptionHandler(
        HttpMessageNotReadableException::class,
        MethodArgumentTypeMismatchException::class,
        ConstraintViolationException::class,
    )
    fun malformedRequest(ex: Exception, request: HttpServletRequest) =
        response(HttpStatus.BAD_REQUEST, "malformed_request", "Request body or parameter is invalid", request.requestURI)

    @ExceptionHandler(MaxUploadSizeExceededException::class)
    fun multipartTooLarge(ex: MaxUploadSizeExceededException, request: HttpServletRequest) =
        response(HttpStatus.PAYLOAD_TOO_LARGE, "file_too_large", "Uploaded file exceeds the configured limit", request.requestURI)

    @ExceptionHandler(
        OptimisticLockException::class,
        ObjectOptimisticLockingFailureException::class,
        DataIntegrityViolationException::class,
    )
    fun conflict(ex: Exception, request: HttpServletRequest) =
        response(HttpStatus.CONFLICT, "conflict", "The resource was modified concurrently", request.requestURI)

    @ExceptionHandler(AccessDeniedException::class)
    fun forbidden(ex: AccessDeniedException, request: HttpServletRequest) =
        response(HttpStatus.FORBIDDEN, "forbidden", "Access denied", request.requestURI)

    @ExceptionHandler(NoResourceFoundException::class)
    fun notFound(ex: NoResourceFoundException, request: HttpServletRequest) =
        response(HttpStatus.NOT_FOUND, "not_found", "Resource not found", request.requestURI)

    @ExceptionHandler(Exception::class)
    fun unexpected(ex: Exception, request: HttpServletRequest): ResponseEntity<ApiError> {
        logger.error("Unhandled API error for {}", request.requestURI, ex)
        return response(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "An unexpected error occurred", request.requestURI)
    }

    private fun response(
        status: HttpStatus,
        code: String,
        message: String,
        path: String,
        fields: Map<String, String>? = null,
    ) = ResponseEntity.status(status).body(
        ApiError(status = status.value(), code = code, message = message, path = path, fieldErrors = fields),
    )
}

@RestController
class HealthController {
    @GetMapping("/health")
    fun health(): ResponseEntity<Map<String, String>> =
        ResponseEntity.ok(mapOf("status" to "UP"))
}
