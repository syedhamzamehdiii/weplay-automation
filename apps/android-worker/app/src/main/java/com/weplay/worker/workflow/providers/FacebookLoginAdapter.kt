package com.weplay.worker.workflow.providers

import com.weplay.worker.workflow.WePlaySelectors

class FacebookLoginAdapter : ProviderLoginAdapter {
    override val provider: String = "FACEBOOK"
    override val loginResourceId: String = WePlaySelectors.LOGIN_FACEBOOK
}
