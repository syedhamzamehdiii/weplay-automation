package com.weplay.worker.workflow.providers

object ProviderLoginAdapters {
    fun forProvider(provider: String): ProviderLoginAdapter {
        return when (provider.uppercase()) {
            "FACEBOOK" -> FacebookLoginAdapter()
            "X" -> XLoginAdapter()
            else -> GoogleLoginAdapter()
        }
    }
}
