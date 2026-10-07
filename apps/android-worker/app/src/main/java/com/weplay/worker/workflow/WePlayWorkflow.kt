package com.weplay.worker.workflow

data class WorkflowFailure(
    val errorCode: String,
    val message: String
)

sealed class WorkflowOutcome {
    data object VerifiedSuccess : WorkflowOutcome()
    data class Failed(val failure: WorkflowFailure) : WorkflowOutcome()
}

interface WePlayWorkflow {
    fun initialize()
    fun checkLoginState(): WorkflowOutcome
    fun createAccount(loginProvider: String): WorkflowOutcome
    fun verifyAccountCreated(): WorkflowOutcome
    fun startProviderLogin(loginProvider: String): WorkflowOutcome
    fun performInitialSetup(loginProvider: String, resume: Boolean): WorkflowOutcome
    fun verifySession(): WorkflowOutcome
    fun navigateToVoiceRooms(): WorkflowOutcome
    fun searchRoom(roomId: String): WorkflowOutcome
    fun enterRoom(): WorkflowOutcome
    fun handlePermissions(): WorkflowOutcome
    fun selectSupportTarget(target: String): WorkflowOutcome
    fun performSupport(): WorkflowOutcome
    fun verifySupport(): WorkflowOutcome
    fun leaveOrRemainInRoom()
    fun cleanup()
}
