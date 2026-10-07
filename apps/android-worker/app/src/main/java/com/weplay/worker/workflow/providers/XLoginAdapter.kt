package com.weplay.worker.workflow.providers

import com.weplay.worker.workflow.WePlaySelectors

class XLoginAdapter : ProviderLoginAdapter {
    override val provider: String = "X"
    override val loginResourceId: String = WePlaySelectors.LOGIN_TWITTER
}
