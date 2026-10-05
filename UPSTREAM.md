# Upstream provenance

This repository combines two modified MIT-licensed upstream repositories:

| Directory | Upstream | Base commit |
| --- | --- | --- |
| `canvas/` | https://github.com/OpenHands/OpenHands | `64f12b3a3294aa78e850c2b0ec32f6bef04ba5fd` |
| `software-agent-sdk/` | https://github.com/OpenHands/software-agent-sdk | `1e1390acc8788346ba4804c34323284009bf3f5e` (v1.50.1) |

Upstream source, license notices, lockfiles and tests are retained within each
directory. Their original package metadata and version numbers are preserved;
this development fork adds `general_agent_foundation_v1` and prepares its local
TypeScript client before Canvas builds. It does not claim to be an upstream
published release. The root launcher and documentation are MIT licensed.
