package com.weplay.worker.api

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class WorkerApiClient(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    var token: String? = null

    fun register(name: String, deviceIdentifier: String, workerVersion: String): JSONObject {
        val body = JSONObject()
            .put("name", name)
            .put("deviceIdentifier", deviceIdentifier)
            .put("workerVersion", workerVersion)
        val response = post("/api/workers/register", body, authorized = false)
        token = response.getString("token")
        return response
    }

    fun heartbeat() = post("/api/workers/heartbeat", JSONObject(), authorized = true)

    fun claim(): JSONObject = post("/api/workers/jobs/claim", JSONObject(), authorized = true)

    fun start(jobId: String, executionId: String) =
        post("/api/workers/jobs/$jobId/start", JSONObject().put("executionId", executionId), true)

    fun progress(jobId: String, executionId: String, event: String, message: String) =
        post(
            "/api/workers/jobs/$jobId/progress",
            JSONObject().put("executionId", executionId).put("event", event).put("message", message),
            true
        )

    fun complete(jobId: String, executionId: String) =
        post(
            "/api/workers/jobs/$jobId/complete",
            JSONObject().put("executionId", executionId).put("verified", true),
            true
        )

    fun fail(jobId: String, executionId: String, errorCode: String, errorMessage: String) =
        post(
            "/api/workers/jobs/$jobId/fail",
            JSONObject()
                .put("executionId", executionId)
                .put("errorCode", errorCode)
                .put("errorMessage", errorMessage),
            true
        )

    private fun post(path: String, body: JSONObject, authorized: Boolean): JSONObject {
        val builder = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .post(body.toString().toRequestBody(jsonType))
        if (authorized) {
            val current = token ?: error("Worker is not registered")
            builder.header("Authorization", "Bearer $current")
        }
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                error("HTTP ${response.code}: $text")
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }
}
