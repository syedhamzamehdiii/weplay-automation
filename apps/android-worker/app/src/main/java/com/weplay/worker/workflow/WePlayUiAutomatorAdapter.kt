package com.weplay.worker.workflow

import com.weplay.worker.workflow.providers.ProviderLoginAdapters

/**
 * Inspected on Oppo CPH2083 (Android 9). Package `com.wejoy.weplay.ar`.
 *
 * `uiautomator dump` is a dummy [0,0][0,0] node on this ColorOS build.
 * Provider login (Google / Facebook / X) is isolated in
 * [com.weplay.worker.workflow.providers]; WePlay navigation stays here.
 * Resource IDs in [WePlaySelectors] come from `dumpsys activity top`.
 * `login_google` is a string resource, not a view ID; USB worker taps
 * WejoyLargeLoginBtnView. This adapter still must not report success until a
 * live WePlay session is verified on device. Tapping a provider button is not success.
 */
class WePlayUiAutomatorAdapter : WePlayWorkflow {
    private val pending = WorkflowOutcome.Failed(
        WorkflowFailure(
            errorCode = "AUTOMATION_NOT_INSPECTED",
            message = "WePlay UI selectors have not been inspected; refusing to report success"
        )
    )

    override fun initialize() = Unit

    override fun checkLoginState(): WorkflowOutcome = verifySession()

    override fun createAccount(loginProvider: String): WorkflowOutcome = pending

    override fun verifyAccountCreated(): WorkflowOutcome = pending

    override fun startProviderLogin(loginProvider: String): WorkflowOutcome {
        ProviderLoginAdapters.forProvider(loginProvider)
        return pending
    }

    override fun performInitialSetup(loginProvider: String, resume: Boolean): WorkflowOutcome {
        if (!resume) {
            when (val login = startProviderLogin(loginProvider)) {
                is WorkflowOutcome.Failed -> return login
                WorkflowOutcome.VerifiedSuccess -> Unit
            }
        }
        return pending
    }

    override fun verifySession(): WorkflowOutcome = pending

    override fun navigateToVoiceRooms(): WorkflowOutcome = pending

    override fun searchRoom(roomId: String): WorkflowOutcome = pending

    override fun enterRoom(): WorkflowOutcome = pending

    override fun handlePermissions(): WorkflowOutcome = pending

    override fun selectSupportTarget(target: String): WorkflowOutcome = pending

    override fun performSupport(): WorkflowOutcome = pending

    override fun verifySupport(): WorkflowOutcome = pending

    override fun leaveOrRemainInRoom() = Unit

    override fun cleanup() = Unit
}
