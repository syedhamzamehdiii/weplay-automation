package com.weplay.worker.workflow

class SupportWorkflowRunner(private val workflow: WePlayWorkflow) {
    fun runCreateAccount(loginProvider: String): WorkflowOutcome {
        workflow.initialize()
        try {
            when (val created = workflow.createAccount(loginProvider)) {
                is WorkflowOutcome.Failed -> return created
                WorkflowOutcome.VerifiedSuccess -> Unit
            }
            return workflow.verifyAccountCreated()
        } finally {
            workflow.cleanup()
        }
    }

    fun runSetup(loginProvider: String, resume: Boolean): WorkflowOutcome {
        workflow.initialize()
        try {
            when (val prepared = workflow.performInitialSetup(loginProvider, resume)) {
                is WorkflowOutcome.Failed -> return prepared
                WorkflowOutcome.VerifiedSuccess -> Unit
            }
            return workflow.verifySession()
        } finally {
            workflow.cleanup()
        }
    }

    fun runJoinRoom(roomId: String): WorkflowOutcome {
        workflow.initialize()
        val steps = listOf(
            { workflow.checkLoginState() },
            { workflow.navigateToVoiceRooms() },
            { workflow.searchRoom(roomId) },
            { workflow.enterRoom() },
            { workflow.handlePermissions() }
        )
        try {
            for (step in steps) {
                when (val outcome = step()) {
                    is WorkflowOutcome.Failed -> return outcome
                    WorkflowOutcome.VerifiedSuccess -> Unit
                }
            }
            return WorkflowOutcome.VerifiedSuccess
        } finally {
            workflow.cleanup()
        }
    }

    fun runSupport(roomId: String, target: String): WorkflowOutcome {
        workflow.initialize()
        val steps = listOf(
            { workflow.checkLoginState() },
            { workflow.navigateToVoiceRooms() },
            { workflow.searchRoom(roomId) },
            { workflow.enterRoom() },
            { workflow.handlePermissions() },
            { workflow.selectSupportTarget(target) },
            { workflow.performSupport() },
            { workflow.verifySupport() }
        )
        try {
            for (step in steps) {
                when (val outcome = step()) {
                    is WorkflowOutcome.Failed -> return outcome
                    WorkflowOutcome.VerifiedSuccess -> Unit
                }
            }
            return WorkflowOutcome.VerifiedSuccess
        } finally {
            workflow.leaveOrRemainInRoom()
            workflow.cleanup()
        }
    }
}
