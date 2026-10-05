"""Start the ordinary Agent Server with the demonstration tools registered."""

from examples.agent_foundation import demo_tools  # noqa: F401
from openhands.agent_server.__main__ import main


if __name__ == "__main__":
    main()
