"""Typed failures for the WePlay Google login flow."""


class FlowError(RuntimeError):
    def __init__(self, step: str, message: str):
        super().__init__(f"{step}: {message}")
        self.step = step


class ActionRequired(FlowError):
    def __init__(self, message: str):
        super().__init__("ACTION_REQUIRED", message)
