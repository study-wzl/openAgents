"""Authenticated installation and discovery endpoints for business packages."""

import asyncio
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import ValidationError

from openhands.agent_server._secrets_exposure import get_config
from openhands.agent_server.agent_foundation.package_models import (
    AgentEffectiveConfig,
    AgentListResponse,
    PackageEnabledRequest,
    PackageInfo,
    PackageListResponse,
    PackageSourceRequest,
    PackageValidation,
)
from openhands.agent_server.agent_foundation.packages import PackageRegistry
from openhands.sdk.profiles.resolver import DanglingMcpServerRef, ProfileNotFound


packages_router = APIRouter(prefix="/agent-foundation", tags=["Agent Foundation"])


def get_package_registry(request: Request) -> PackageRegistry:
    registry = getattr(request.app.state, "package_registry", None)
    if registry is not None:
        return registry
    return PackageRegistry(config=get_config(request))


async def _call[Result](operation: Callable[[], Result]) -> Result:
    try:
        return await asyncio.to_thread(operation)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValidationError as exc:
        detail = [
            {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
            for error in exc.errors(include_input=False)
        ]
        raise HTTPException(status_code=422, detail=detail) from exc
    except (ValueError, OSError, ProfileNotFound, DanglingMcpServerRef) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# @spec GAF-001 — Packages are validated before an atomic active-version change
@packages_router.get("/packages")
async def list_packages(request: Request) -> PackageListResponse:
    registry = get_package_registry(request)
    return PackageListResponse(packages=await _call(registry.list_packages))


@packages_router.post("/packages/validate")
async def validate_package(
    body: PackageSourceRequest, request: Request
) -> PackageValidation:
    registry = get_package_registry(request)
    return await _call(lambda: registry.validate(body.source))


@packages_router.post("/packages/install")
async def install_package(body: PackageSourceRequest, request: Request) -> PackageInfo:
    registry = get_package_registry(request)
    return await _call(lambda: registry.install(body.source))


@packages_router.patch("/packages/{package_id}")
async def set_package_enabled(
    package_id: str, body: PackageEnabledRequest, request: Request
) -> PackageInfo:
    registry = get_package_registry(request)
    return await _call(lambda: registry.set_enabled(package_id, body.enabled))


@packages_router.delete("/packages/{package_id}", status_code=204)
async def uninstall_package(package_id: str, request: Request) -> Response:
    registry = get_package_registry(request)
    await _call(lambda: registry.uninstall(package_id))
    return Response(status_code=204)


@packages_router.get("/agents")
async def list_agents(request: Request) -> AgentListResponse:
    registry = get_package_registry(request)
    return AgentListResponse(agents=await _call(registry.list_agents))


@packages_router.get("/agents/{package_id}/{agent_id}/config")
async def get_agent_config(
    package_id: str, agent_id: str, request: Request, version: str | None = None
) -> AgentEffectiveConfig:
    registry = get_package_registry(request)
    return await _call(
        lambda: registry.effective_config(f"{package_id}/{agent_id}", version)
    )
