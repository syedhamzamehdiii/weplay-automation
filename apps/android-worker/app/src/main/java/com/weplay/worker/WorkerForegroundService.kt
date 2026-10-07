package com.weplay.worker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import com.weplay.worker.api.WorkerApiClient
import com.weplay.worker.workflow.SupportWorkflowRunner
import com.weplay.worker.workflow.WePlayUiAutomatorAdapter
import com.weplay.worker.workflow.WorkflowOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class WorkerForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, notification())
        if (loop == null) {
            loop = scope.launch { runLoop() }
        }
        return START_STICKY
    }

    private suspend fun runLoop() {
        val prefs = getSharedPreferences("worker", MODE_PRIVATE)
        val baseUrl = prefs.getString("apiBaseUrl", BuildConfig.API_BASE_URL) ?: BuildConfig.API_BASE_URL
        val api = WorkerApiClient(baseUrl)
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        api.register("android-$deviceId", deviceId, BuildConfig.VERSION_NAME)
        val runner = SupportWorkflowRunner(WePlayUiAutomatorAdapter())

        while (scope.isActive) {
            try {
                api.heartbeat()
                val claim = api.claim()
                val job = claim.optJSONObject("job")
                if (job != null) {
                    val jobId = job.getString("id")
                    val executionId = job.getString("executionId")
                    val configuration = job.getJSONObject("configuration")
                    val kind = configuration.optString("kind", "support")
                    api.start(jobId, executionId)
                    val outcome = when (kind) {
                        "create_account" -> {
                            val provider = configuration.optString("loginProvider", "GOOGLE")
                            api.progress(jobId, executionId, "ACCOUNT_CREATION_PROGRESS", "Starting WePlay signup ($provider)")
                            runner.runCreateAccount(provider)
                        }
                        "setup", "reauth" -> {
                            val provider = configuration.optString("loginProvider", "GOOGLE")
                            val resume = configuration.optBoolean("resume", kind == "reauth")
                            api.progress(jobId, executionId, "ACCOUNT_SETUP_PROGRESS", "Starting $provider WePlay sign-in")
                            runner.runSetup(provider, resume)
                        }
                        "join_room" -> {
                            val roomId = configuration.optString("roomId")
                            api.progress(jobId, executionId, "JOB_STARTED", "Joining room $roomId")
                            runner.runJoinRoom(roomId)
                        }
                        else -> {
                            val roomId = configuration.optString("roomId")
                            val target = configuration.optString("supportTarget")
                            api.progress(jobId, executionId, "JOB_STARTED", "Executing $kind")
                            runner.runSupport(roomId, target)
                        }
                    }
                    when (outcome) {
                        is WorkflowOutcome.VerifiedSuccess -> api.complete(jobId, executionId)
                        is WorkflowOutcome.Failed -> api.fail(
                            jobId,
                            executionId,
                            outcome.failure.errorCode,
                            outcome.failure.message
                        )
                    }
                }
            } catch (_: Exception) {
                delay(3_000)
            }
            delay(1_000)
        }
    }

    private fun notification(): Notification {
        val channelId = "worker"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(channelId, "WePlay worker", NotificationManager.IMPORTANCE_LOW)
            )
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
                .setContentTitle("WePlay worker")
                .setContentText("Polling for jobs")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("WePlay worker")
                .setContentText("Polling for jobs")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .build()
        }
    }
}
