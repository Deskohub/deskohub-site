# Disposable synthetic RPC probe for the hosted sandbox proof. The build context
# is the directory build.ts wrote probe.mjs to:
#   bun packages/workspace-infrastructure/sandbox-probe/build.ts --outdir <dir>
#   docker build -f packages/workspace-infrastructure/sandbox-probe/Dockerfile \
#     --build-arg PROBE_BUILD_VERSION=v1 <dir>
# Cloud Run sets WORKSPACE_SERVICE_ROLE (api, tasks-worker or scheduler-worker).
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

ARG PROBE_BUILD_VERSION=dev
ENV PROBE_BUILD_VERSION=${PROBE_BUILD_VERSION} \
    NODE_ENV=production \
    PORT=8080

WORKDIR /probe
COPY probe.mjs ./
USER node
EXPOSE 8080
CMD ["node", "probe.mjs"]
