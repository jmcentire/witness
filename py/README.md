# witness-client

Python HTTP client for the witness human-in-the-loop coordination primitive.

```python
from witness_client import WitnessClient

async with WitnessClient(base_url="http://localhost:8787") as w:
    decision_id = await w.ask(
        kind="scram.confirm-global-readonly",
        input={"reason": "burn rate spike"},
        response_shape={"decision": "string"},
        authorized_roles=["scram.operator"],
        surfaces=["inbox", "pagerduty"],
        context_snapshot={"phase": "emergency"},
    )
```

The client mirrors the witness TypeScript API; see the witness repo
README for the full interface and the state-based two-person window
contract.
