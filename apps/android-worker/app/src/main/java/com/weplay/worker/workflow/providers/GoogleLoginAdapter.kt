package com.weplay.worker.workflow.providers

import com.weplay.worker.workflow.WePlaySelectors

class GoogleLoginAdapter : ProviderLoginAdapter {
    override val provider: String = "GOOGLE"
    override val loginResourceId: String = WePlaySelectors.LOGIN_GOOGLE
}
