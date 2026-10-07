package com.weplay.worker

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        val input = findViewById<EditText>(R.id.apiUrl)
        val status = findViewById<TextView>(R.id.status)
        val prefs = getSharedPreferences("worker", MODE_PRIVATE)
        input.setText(prefs.getString("apiBaseUrl", BuildConfig.API_BASE_URL))

        findViewById<Button>(R.id.startWorker).setOnClickListener {
            prefs.edit().putString("apiBaseUrl", input.text.toString().trim()).apply()
            startForegroundService(Intent(this, WorkerForegroundService::class.java))
            status.text = "Worker service started. Jobs will fail with AUTOMATION_NOT_INSPECTED until WePlay UI is mapped."
        }
    }
}
